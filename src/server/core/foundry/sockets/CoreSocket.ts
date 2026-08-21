
import { io, Socket } from 'socket.io-client';
import { SocketBase } from './SocketBase';
import { logger } from '@shared/utils/logger';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import type { FoundryBootstrapSnapshot } from './FoundrySocketEvents';

export class CoreSocket extends SocketBase {
    // Service-account identity is still a transport concern: the socket needs
    // it for login/session restoration. World snapshots live in WorldStateStore.
    public userId: string | null = null;

    // Core Socket maintains the singular connection
    private consecutiveFailures = 0;
    private isConnecting = false;

    constructor(config: any) {
        super(config);
    }

    public get isConnectionAttemptInFlight(): boolean {
        return this.isConnecting;
    }

    /**
     * Get the current World status upon initial connection.
     */
    private async getWorldStatus(): Promise<boolean> {
        if (!this.socket || !this.socket.connected) return false;
        return new Promise((resolve) => {
            const t = setTimeout(() => resolve(false), 5000);
            this.socket!.emit('getWorldStatus', (status: boolean) => {
                clearTimeout(t);
                resolve(status);
            });
        });
    }

    /**
     * Request World data from server and return it.
     */
    private async getWorldData(): Promise<any> {
        if (!this.socket || !this.socket.connected) return null;
        return new Promise((resolve) => {
            const t = setTimeout(() => resolve(null), 10000);
            this.socket!.emit('world', (data: any) => {
                clearTimeout(t);
                resolve(data);
            });
        });
    }

    /**
     * Request Scene data from server and return it.
     * Extracts scenes from the world data already fetched
     */
    private async fetchSceneData(worldData?: any): Promise<any> {
        if (!this.socket || !this.socket.connected) return null;
        try {
            // Scenes are already included in the world data
            const data = worldData ?? await this.getWorldData();
            if (data && data.scenes) {
                // Convert scenes array to map by ID for easier lookup
                const sceneMap: any = {};
                data.scenes.forEach((scene: any) => {
                    sceneMap[scene._id || scene.id] = scene;
                });
                return sceneMap;
            }
            return null;
        } catch (error: unknown) {
            logger.warn(`CoreSocket | Failed to fetch scene data: ${getErrorMessage(error)}`);
            return null;
        }
    }

    public async getBootstrapSnapshot(): Promise<FoundryBootstrapSnapshot | null> {
        logger.info('CoreSocket | Fetching game data via socket for bootstrap...');
        const gameData = await this.getWorldData();
        if (!gameData) return null;

        const sceneData = await this.fetchSceneData(gameData);
        if (gameData.userId) {
            this.userId = gameData.userId;
        }

        if (sceneData) {
            logger.info('CoreSocket | Scene Data fetched for bootstrap');
        } else {
            logger.warn('CoreSocket | Scene data unavailable during bootstrap');
        }

        return { gameData, sceneData };
    }


    async connect(): Promise<void> {
        if (this.isConnected) return;
        if (this.isConnecting) return;

        this.isConnecting = true;
        const baseUrl = this.getBaseUrl();
        logger.info(`CoreSocket | Connecting to ${baseUrl}...`);

        try {
            // 1. Handshake & CSRF
            const { csrfToken, isSetupMatch, pageTitle } = await this.performHandshake(baseUrl);

            // Detection: True Setup OR Gray State (No CSRF AND Title indicates failure/generic)
            // If the title is a specific world name, we should try to connect.
            const isGenericOrErrorTitle = !pageTitle || pageTitle === 'Foundry Virtual Tabletop' || pageTitle.includes('Critical Failure');

            if (isSetupMatch || (!csrfToken && isGenericOrErrorTitle)) {
                this.emit('foundry:setupDetected', { pageTitle });
                return;
            }

            if (pageTitle && !isGenericOrErrorTitle) {
                logger.info(`CoreSocket | World Detected (${pageTitle}).`);
                this.emit('foundry:worldTitleDetected', { pageTitle });
            }

            // 2. Discovery (Guest Probe)
            logger.info('CoreSocket | Probing world state (Guest Socket)...');
            const joinData = await this.probeWorldState(baseUrl);

            if (joinData && joinData.world) {
                logger.info(`CoreSocket | Discovered world "${joinData.world.title}" via Probe.`);
                const probeUserCount = Array.isArray(joinData.users) ? joinData.users.length : 0;
                this.emit('foundry:worldDiscovered', {
                    world: joinData.world,
                    userCount: probeUserCount,
                });
            } else {
                this.emit('foundry:worldMissing');
                return;
            }

            // Identify Service Account ID (Resolve ID from username). UserStore isn't
            // seeded yet at this point (the coordinator runs after the main socket connects),
            // so look up the service account directly from the probe's joinData.users.
            if (this.config.username) {
                const probeUsers: any[] = Array.isArray(joinData?.users) ? joinData.users : [];
                const user = probeUsers.find((u: any) => u.name === this.config.username);
                if (user) {
                    this.userId = user._id || user.id;
                    logger.info(`CoreSocket | Resolved Service Account ID: ${this.userId} (Username: ${this.config.username})`);
                } else {
                    const availableUsers = probeUsers.map((u: any) => `${u.name} (role: ${u.role})`);
                    logger.error(`CoreSocket | Service account "${this.config.username}" not found in world "${joinData.world?.title || 'unknown'}". Available users: [${availableUsers.join(', ') || 'none'}].`);
                    this.emit('foundry:serviceAccountMissing', {
                        username: this.config.username,
                        worldTitle: joinData.world?.title,
                        availableUsers,
                    });
                    return;
                }
            }

            // 3. Login Service Account
            if (this.userId) {
                // Ensure we have the latest CSRF from cookie if scrape missed it
                const finalCsrf = csrfToken || this.cookieMap.get('csrf-token') || this.cookieMap.get('xsrf-token') || null;
                await this.performLogin(baseUrl, this.userId, finalCsrf);
            } else {
                logger.warn('CoreSocket | No User ID resolved, skipping explicit POST login step.');
            }

            // 4. Connect Main Socket
            const sessionId = this.getSessionId();
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("Socket connection timeout")), 15000);

                this.socket = io(baseUrl, {
                    path: '/socket.io',
                    transports: ['websocket'],
                    upgrade: false,
                    reconnection: true,
                    query: sessionId ? { session: sessionId } : {},
                    auth: sessionId ? { session: sessionId } : {},
                    extraHeaders: {
                        'Cookie': this.sessionCookie || '',
                        'User-Agent': 'SheetDelver/1.0'
                    },
                    transportOptions: {
                        websocket: {
                            extraHeaders: {
                                'Cookie': this.sessionCookie || '',
                                'User-Agent': 'SheetDelver/1.0'
                            }
                        }
                    }
                });

                this.socket.on('connect', async () => {
                    logger.info(`CoreSocket | Main Socket Transport Connected. socket.id: ${this.socket?.id}`);
                    this.isSocketConnected = true;
                    this.setupSharedContentListeners(this.socket!);

                    // 5. Verify World Status
                    const isActive = await this.getWorldStatus();
                    if (!isActive) {
                        logger.warn('CoreSocket | Socket connected but world is NOT active.');
                        this.emit('foundry:worldInactive');
                        clearTimeout(timeout);
                        // Still emit connect for setup mode to release the bootstrap lock
                        this.emit('connect');
                        resolve();
                        return;
                    }

                    logger.info('CoreSocket | Foundry world is ACTIVE. Handing application bootstrap to WorldBootstrapper...');
                    this.emit('foundry:worldActive');

                    clearTimeout(timeout);
                    this.emit('connect');
                    resolve();
                });

                this.socket.on('disconnect', (reason: string) => {
                    logger.info(`CoreSocket | Socket Disconnected: ${reason}`);
                    this.isSocketConnected = false;
                    this.emit('foundry:transportDisconnected', { reason });
                    this.emit('disconnect', reason);
                });

                this.socket.on('shutdown', () => {
                    logger.warn('CoreSocket | Native Shutdown signal received from Foundry. World is closing.');
                    this.emit('foundry:shutdown');
                });

                this.socket.on('reload', () => {
                    logger.info('CoreSocket | Native Reload signal received from Foundry. State transition detected.');
                    this.emit('foundry:reload');
                });

                this.socket.on('progress', (data: any) => {
                    this.emit('foundry:progress', { data });
                });

                this.socket.on('connect_error', (err) => {
                    logger.error(`CoreSocket | Socket connection error: ${err.message}. State: connected=${this.socket?.connected}, active=${(this.socket as Socket & { active?: boolean })?.active}`);
                    clearTimeout(timeout);
                    reject(err);
                });

                this.socket.on('session', (data: any) => {
                    if (data && data.userId && !this.userId) {
                        logger.info(`CoreSocket | Acquired User ID from session event: ${data.userId}`);
                        this.userId = data.userId;
                    }
                });

                this.socket.on('userConnected', (user: any) => {
                    this.emit('foundry:userConnected', { user });
                });

                this.socket.on('userDisconnected', (data: any) => {
                    this.emit('foundry:userDisconnected', { data });
                });

                this.socket.on('userActivity', (userId: string, data: any) => {
                    this.emit('foundry:userActivity', { userId, data });
                });

                this.socket.on('modifyDocument', (data: any) => {
                    this.emit('foundry:modifyDocument', {
                        type: data.type,
                        action: data.action,
                        result: data.result,
                        operation: data.operation,
                    });
                });

                this.socket.on('createUser', (user: any) => {
                    this.emit('foundry:documentCompatibility', {
                        type: 'User',
                        action: 'create',
                        result: [user],
                    });
                });
                this.socket.on('updateUser', (user: any) => {
                    this.emit('foundry:documentCompatibility', {
                        type: 'User',
                        action: 'update',
                        result: [user],
                    });
                });
                this.socket.on('deleteUser', (id: string | any) => {
                    const userId = typeof id === 'string' ? id : (id?._id || id?.id);
                    if (!userId) return;
                    logger.info(`CoreSocket | User deleted: ${userId}`);
                    this.emit('foundry:documentCompatibility', {
                        type: 'User',
                        action: 'delete',
                        result: null,
                        operation: { ids: [userId] },
                    });
                });
            });

        } catch (error: unknown) {
            logger.error(`CoreSocket | Connection flow failed: ${getErrorMessage(error)}`);
            this.emit('foundry:connectionFailed', { message: getErrorMessage(error) });
        } finally {
            this.isConnecting = false;
        }
    }

    public async checkStatus() {
        return this.performHandshake(this.getBaseUrl());
    }

    public disconnect() {
        this.isConnecting = false;
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
            this.isSocketConnected = false;
            logger.info('CoreSocket | Explicitly disconnected.');
        }
    }

    public async postSetupAction<T = unknown>(payload: Record<string, unknown>): Promise<T> {
        const response = await fetch(`${this.getBaseUrl()}/setup`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cookie': this.sessionCookie || '',
                'User-Agent': 'SheetDelver/1.0',
            },
            body: JSON.stringify(payload),
            redirect: 'manual',
        });

        const text = await response.text();
        let data: unknown = {};
        if (text.trim()) {
            try {
                data = JSON.parse(text);
            } catch {
                data = { raw: text };
            }
        }

        if (!response.ok) {
            throw new Error(`Foundry setup request failed with status ${response.status}: ${text.slice(0, 200)}`);
        }

        if (data && typeof data === 'object' && 'error' in data) {
            const errorValue = (data as { error?: unknown }).error;
            throw new Error(typeof errorValue === 'string' ? errorValue : JSON.stringify(errorValue));
        }

        return data as T;
    }




    // Rename to avoid conflict with EventEmitter
    public async emitSocketEvent<T>(event: string, ...payloads: any[]): Promise<T> {
        if (!this.socket || !this.isConnected) throw new Error(`Not connected to Foundry`);

        // Default timeout to 10s for better reliability on compendium lookups
        let timeoutMs = 10000;
        const lastArg = payloads[payloads.length - 1];
        if (typeof lastArg === 'number' && payloads.length > 1) {
            timeoutMs = payloads.pop();
        }

        const sid = this.getSessionId()?.slice(0, 8) || 'none';
        logger.debug(`[CoreSocket] [TRACE] emitSocketEvent: ${event} (SID: ${sid}...)`);

        return new Promise((resolve, reject) => {
            this.socket!.emit(event, ...payloads, (response: any) => {
                if (response?.error) {
                    reject(new Error(typeof response.error === 'string' ? response.error : JSON.stringify(response.error)));
                } else {
                    resolve(response);
                }
            });
            setTimeout(() => {
                const state = `connected=${this.socket?.connected}, active=${(this.socket as Socket & { active?: boolean })?.active}`;
                reject(new Error(`Timeout waiting for event: ${event}. Socket Context: ${state}, SID: ${sid}`));
            }, timeoutMs);
        });
    }

    public async dispatchDocumentSocket(type: string, action: string, operation: any = {}, parent?: { type: string, id: string }, failHard: boolean = true): Promise<any> {
        if (!this.socket?.connected) throw new Error('Socket not connected');

        // Normalize data and updates to arrays if provided
        if (operation.data && !Array.isArray(operation.data)) {
            operation.data = [operation.data];
        }
        if (operation.updates && !Array.isArray(operation.updates)) {
            operation.updates = [operation.updates];
        }

        if (parent) {
            // Mapping simplistic type/id to UUID
            operation.parentUuid = `${parent.type}.${parent.id}`;
        }
        else if (operation.parent && typeof operation.parent === 'object') {
            operation.parentUuid = `${operation.parent.type}.${operation.parent.id}`;
            delete operation.parent;
        }

        try {
            const result: any = await this.emitSocketEvent('modifyDocument', { type, action, operation }, 5000);
            this.consecutiveFailures = 0;

            // Per ADR-0021, compendium pack operations (`operation.pack` set) are
            // pack-scoped reads. Foundry's CONST.COMPENDIUM_DOCUMENT_TYPES overlap
            // with world primary documents (Actor, Item, JournalEntry, …), so the
            // boundary is scope, not the returned document `type`. Pack-scoped
            // results must not mirror into world Stores.
            const isPackScoped = Boolean(operation && operation.pack);

            if (result && !isPackScoped) {
                this.emit('foundry:documentDispatchConfirmed', {
                    type,
                    action,
                    result: result.result,
                    operation: result.operation || operation,
                });
            }

            return result;
        } catch (error: unknown) {
            if (failHard) this.consecutiveFailures++;
            throw error;
        }
    }

    async dispatchDocument(type: string, action: string, operation?: any, parent?: { type: string, id: string }): Promise<any> {
        return await this.dispatchDocumentSocket(type, action, operation, parent);
    }

}
