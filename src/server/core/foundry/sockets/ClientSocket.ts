import { io } from 'socket.io-client';
import { SocketBase } from './SocketBase';
import { logger } from '@shared/utils/logger';
import { FoundryConfig } from '../types';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';

export class ClientSocket extends SocketBase {
    public userId: string | null = null;
    public isExplicitSession: boolean = false;
    private isRestored: boolean = false;

    constructor(config: FoundryConfig) {
        super(config);
    }

    async connect(): Promise<void> {
        if (this.isConnected) return;
        const baseUrl = this.getBaseUrl();
        logger.info(`ClientSocket | Connecting Presence Anchor for user ${this.config.username}...`);

        try {
            const restoredCookie = this.isRestored ? this.sessionCookie : null;

            // 1. Handshake & CSRF
            const { csrfToken, isSetupMatch } = await this.performHandshake(baseUrl);

            if (this.isRestored && restoredCookie) {
                this.updateCookies(restoredCookie);
                logger.debug(`ClientSocket | Restored authenticated cookie after handshake`);
            }

            if (isSetupMatch) {
                throw new Error("Cannot connect ClientSocket in Setup Mode");
            }

            // 2. Identification (via Discovery Probe or CoreSocket)
            if (!this.userId) {
                logger.info('ClientSocket | Identifying user ID...');
                // User lookup priority during ADR-0014:
                // 1. UserStore after the active-world bootstrap.
                // 2. WorldStateStore's raw `game.data.users` snapshot while
                //    user discovery still depends on the bootstrap payload.
                // 3. Probe fallback before a full bootstrap is possible.
                const storeUser = userStore.isReady() ? userStore.findByName(this.config.username || '') : null;
                const coreData = worldStateStore.getGameDataSnapshot();
                const users = storeUser ? [storeUser] : (coreData?.users || (await this.probeWorldState(baseUrl))?.users);

                const user = users?.find((u: any) => u.name === this.config.username);
                if (user) {
                    this.userId = user._id;
                }
            }

            if (!this.userId) {
                throw new Error(`Could not identify user ID for ${this.config.username}`);
            }

            // 3. Login (Skip if we already have a session cookie from restoration)
            if (!this.isRestored) {
                await this.performLogin(baseUrl, this.userId, csrfToken);
            } else {
                logger.info(`ClientSocket | Bypassing login, using restored session cookie for ${this.userId}`);
            }

            // 4. Connect Main Socket
            const sessionId = this.getSessionId();
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("ClientSocket connection timeout")), 15000);

                this.socket = io(baseUrl, {
                    path: '/socket.io',
                    transports: ['websocket'],
                    upgrade: false,
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

                this.socket.on('session', (data: any) => {
                    if (data && data.userId) {
                        logger.info(`ClientSocket | Session verified for user ${data.userId}`);
                        this.userId = data.userId;
                        this.isSocketConnected = true;
                        this.setupSharedContentListeners(this.socket!);
                        this.setupSocketRelays(this.socket!);
                        clearTimeout(timeout);
                        this.emit('connect');
                        resolve();
                    }
                });

                this.socket.on('connect', () => {
                    logger.debug(`ClientSocket | Socket transport connected for ${this.userId}. Waiting for session event...`);
                });

                this.socket.on('disconnect', (reason: string) => {
                    logger.info(`ClientSocket | Presence Socket Disconnected: ${reason}`);
                    this.isSocketConnected = false;
                    this.emit('disconnect', reason);
                });

                this.socket.on('connect_error', (err) => {
                    logger.error(`ClientSocket | Socket connection error: ${err.message}`);
                    clearTimeout(timeout);
                    reject(err);
                });
            });

        } catch (error: unknown) {
            logger.error(`ClientSocket | Connection failed: ${getErrorMessage(error)}`);
            throw error;
        }
    }

    public async login(username?: string, password?: string): Promise<void> {
        if (username) this.config.username = username;
        if (password) this.config.password = password;
        this.isExplicitSession = true;
        await this.connect();
    }

    public async restoreSession(cookie: string, userId: string): Promise<void> {
        logger.info(`ClientSocket | Restoring session for user ${userId}...`);
        this.userId = userId;
        this.sessionCookie = cookie;
        this.isExplicitSession = true;
        this.isRestored = true;

        // Populate cookieMap from existing cookie string
        const parts = cookie.split(';');
        parts.forEach(p => {
            const [k, v] = p.split('=');
            if (k && v) this.cookieMap.set(k.trim(), v.trim());
        });

        await this.connect();
    }

    public async validateSession(expectedWorldId: string): Promise<boolean> {
        if (!this.isConnected || !this.userId) return false;
        // Session/world matching reads the Store, not CoreSocket, so a user
        // presence socket does not depend on transport-owned world metadata.
        const currentWorldId = worldStateStore.getCurrentWorldId();
        return currentWorldId === expectedWorldId;
    }

    // --- Public API / transport helpers ---
    // UUID routing moved to DocumentResolver in ADR-0016 and adapter ownership
    // moved to WorldBootstrapper in ADR-0017 Phase 3, so this user socket
    // exposes only transport-level document helpers.

    public async emitSocketEvent<T>(event: string, payload: any, timeoutMs: number = 5000): Promise<T> {
        if (!this.socket || !this.isConnected) throw new Error(`Not connected to Foundry`);

        return new Promise((resolve, reject) => {
            this.socket!.emit(event, payload, (response: any) => {
                if (response?.error) {
                    reject(new Error(typeof response.error === 'string' ? response.error : JSON.stringify(response.error)));
                } else {
                    resolve(response);
                }
            });
            setTimeout(() => reject(new Error(`Timeout waiting for event: ${event}`)), timeoutMs);
        });
    }

    public async dispatchDocument(type: string, action: string, operation: any = {}, parent?: { type: string, id: string }): Promise<any> {
        // User-scoped document writes must fail closed if the user's Foundry
        // socket is unavailable. Falling back to CoreSocket would perform the
        // write as the system account and bypass the user's Foundry ownership.
        if (!this.isConnected || !this.socket) {
            throw new Error('Cannot dispatch Foundry document mutation: user socket is not connected');
        }

        if (parent) {
            operation.parentUuid = `${parent.type}.${parent.id}`;
        }
        else if (operation.parent && typeof operation.parent === 'object') {
            operation.parentUuid = `${operation.parent.type}.${operation.parent.id}`;
            delete operation.parent;
        }

        try {
            return await this.emitSocketEvent('modifyDocument', { type, action, operation }, 5000);
        } catch (error: unknown) {
            logger.warn(`ClientSocket | Dispatch failed on user socket: ${getErrorMessage(error)}`);
            throw error;
        }
    }

    public async dispatchDocumentSocket(type: string, action: string, data?: any, parent?: any): Promise<any> {
        return this.dispatchDocument(type, action, data, parent);
    }

    private setupSocketRelays(socket: any) {
        // Lifecycle relay
        socket.on('shutdown', () => {
            logger.warn(`ClientSocket | Relay: World Shutdown detected for ${this.userId}`);
            this.emit('worldShutdown');
        });

        socket.on('reload', () => {
            logger.info(`ClientSocket | Relay: World Reload detected for ${this.userId}`);
            this.emit('worldReload');
        });
    }
}
