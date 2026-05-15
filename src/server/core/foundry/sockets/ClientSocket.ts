import { io } from 'socket.io-client';
import { SocketBase } from './SocketBase';
import { logger } from '@shared/utils/logger';
import { systemService } from '../../system/SystemService';
import { FoundryConfig } from '../types';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';

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
                // Prefer user map from CoreSocket if available
                const coreData = systemService.getSystemClient().getGameData();
                const users = coreData?.users || (await this.probeWorldState(baseUrl))?.users;

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
                        this.setupDocumentListeners(this.socket!);
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
        // Check core for world ID match
        const currentWorldId = systemService.getSystemClient().getGameData()?.world?.id;
        return currentWorldId === expectedWorldId;
    }

    // --- Data Operations (Proxied to CoreSocket with userId filtering) ---

    public async getJournals(): Promise<any[]> {
        return systemService.getSystemClient().getJournals(this.userId || undefined);
    }

    public async getChatLog(limit = 100): Promise<any[]> {
        // If we have an active user socket, use it to leverage Foundry's native filtering
        if (this.isConnected && this.socket) {
            try {
                const response: any = await this.dispatchDocumentSocket('ChatMessage', 'get', {
                    broadcast: false,
                    limit: limit
                });
                const raw = response?.result || [];

                // 1. Sort Chronologically (Oldest -> Newest)
                const sorted = [...raw].sort((a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0));

                // 2. Filter based on visibility (replicate Foundry's ChatMessage.visible)
                const user = systemService.getSystemClient().getUser(this.userId || '');
                const isGM = (user?.role || 0) >= 3;

                const visible = sorted.filter((msg: any) => {
                    // Replicate Foundry's ChatMessage.visible getter logic
                    if (msg.whisper && msg.whisper.length > 0) {
                        // Whispers: visible to author, recipients, or GM
                        const isAuthor = msg.user === this.userId;
                        const isRecipient = msg.whisper.includes(this.userId);
                        return isAuthor || isRecipient || isGM;
                    }
                    // Public messages: visible to all
                    return true;
                });

                logger.debug(`ClientSocket | User Socket: ${sorted.length} total, ${visible.length} visible (filtered ${sorted.length - visible.length})`);

                return visible.map((msg: any) => {
                    const rolls = (msg.rolls || []).map((r: any) => {
                        if (typeof r === 'string') {
                            try {
                                return JSON.parse(r);
                            } catch (error) {
                                logger.debug(`ClientSocket | Failed to parse chat roll JSON for message ${msg._id || msg.id || 'unknown'}. Returning raw roll value.`);
                                return r;
                            }
                        }
                        return r;
                    });

                    const roll = rolls[0];
                    const isRoll = msg.type === 5;
                    const isBlind = msg.blind === true;

                    // Masking: Hide roll results from non-GMs if message is blind
                    const shouldMask = isBlind && !isGM;

                    // Resolve Name: Prioritize User Name from author ID map
                    const author = systemService.getSystemClient().getUser(msg.author);
                    const userName = author?.name || msg.alias || 'Unknown';

                    return {
                        ...msg,
                        user: userName,
                        timestamp: msg.timestamp || Date.now(),
                        isRoll: isRoll,
                        rolls: shouldMask ? [] : rolls,
                        rollTotal: shouldMask ? undefined : (roll?.total !== undefined ? roll.total : (isRoll ? msg.content : undefined)),
                        rollFormula: shouldMask ? "???" : (roll?.formula || (isRoll ? msg.flavor : undefined)),
                        flavor: msg.flavor
                    };
                });
            } catch (error: unknown) {
                logger.warn(`ClientSocket | Failed to fetch chat via user socket: ${getErrorMessage(error)}. Falling back to proxy.`);
            }
        }

        return systemService.getSystemClient().getChatLog(limit, this.userId || undefined);
    }


    public async sendMessage(content: string | any, options?: { rollMode?: string, speaker?: any }): Promise<any> {
        if (!this.userId) throw new Error("User ID not set on ClientSocket");
        return systemService.getSystemClient().sendMessage(content, this.userId, options);
    }

    public async roll(formula: string, flavor?: string, options?: { userId?: string, rollMode?: string, speaker?: any, displayChat?: boolean, flags?: any }): Promise<any> {
        return systemService.getSystemClient().roll(formula, flavor, {
            userId: this.userId || options?.userId,
            rollMode: options?.rollMode,
            speaker: options?.speaker,
            displayChat: options?.displayChat,
            flags: options?.flags
        });
    }

    public async getActors(): Promise<any[]> {
        return systemService.getSystemClient().getActors(this.userId || undefined);
    }

    public async getActor(id: string): Promise<any> {
        return systemService.getSystemClient().getActor(id);
    }

    public async getSystem(): Promise<any> {
        return systemService.getSystemClient().getSystem();
    }

    public async getUsers(): Promise<any[]> {
        return systemService.getSystemClient().getUsers();
    }

    public async getCombats(): Promise<any[]> {
        return systemService.getSystemClient().getCombats();
    }

    public async getFolders(type?: string): Promise<any[]> {
        return systemService.getSystemClient().getFolders(type);
    }

    public async updateActor(id: string, data: any): Promise<any> {
        // --- Update Funnel (Defensive Approver) ---
        const adapter = this.getSystemAdapter();
        if (adapter && adapter.validateUpdate) {
            const filteredData: any = {};
            let hasValidUpdates = false;

            for (const [path, value] of Object.entries(data)) {
                if (adapter.validateUpdate(path, value)) {
                    filteredData[path] = value;
                    hasValidUpdates = true;
                } else {
                    logger.warn(`ClientSocket | Rejected unsanctioned update path: ${path} for actor ${id}`);
                }
            }

            if (!hasValidUpdates) {
                logger.info(`ClientSocket | No sanctioned updates to process for actor ${id}`);
                return { success: true, message: 'No sanctioned updates' };
            }

            return this.dispatchDocument('Actor', 'update', { updates: [{ _id: id, ...filteredData }] });
        }

        // Fallback or generic systems
        return this.dispatchDocument('Actor', 'update', { updates: [{ _id: id, ...data }] });
    }

    public async createActor(data: any): Promise<any> {
        // Normalize to array for 'data' field in socket operation
        const batch = Array.isArray(data) ? data : [data];
        const response = await this.dispatchDocument('Actor', 'create', { data: batch });
        // Return first document if single creation, otherwise full result array
        return Array.isArray(data) ? response?.result : response?.result?.[0];

        //return systemService.getSystemClient().createActor(data);
    }

    public async deleteActor(id: string): Promise<any> {
        return systemService.getSystemClient().deleteActor(id);
    }

    public async createActorItem(actorId: string, itemData: any): Promise<any> {
        return systemService.getSystemClient().createActorItem(actorId, itemData);
    }

    public async updateActorItem(actorId: string, itemData: any): Promise<any> {
        const { _id, id, ...updates } = itemData;
        const targetId = _id || id;
        return this.dispatchDocument('Item', 'update', { updates: [{ _id: targetId, ...updates }] }, { type: 'Actor', id: actorId });
    }

    public async deleteActorItem(actorId: string, itemId: string): Promise<any> {
        return this.dispatchDocument('Item', 'delete', { ids: [itemId] }, { type: 'Actor', id: actorId });
    }

    public async fetchByUuid(uuid: string): Promise<any> {
        return systemService.getSystemClient().fetchByUuid(uuid);
    }

    public async useItem(actorId: string, itemId: string): Promise<any> {
        return systemService.getSystemClient().useItem(actorId, itemId);
    }

    public async getAllCompendiumIndices(): Promise<any[]> {
        return systemService.getSystemClient().getAllCompendiumIndices();
    }

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
        // If we represent a user session and are connected, USE OUR OWN SOCKET to act as the User
        if (this.isConnected && this.socket) {
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

        return systemService.getSystemClient().dispatchDocument(type, action, operation, parent);
    }

    public async dispatchDocumentSocket(type: string, action: string, data?: any, parent?: any): Promise<any> {
        return this.dispatchDocument(type, action, data, parent);
    }

    public async getActorRaw(id: string): Promise<any> {
        return systemService.getSystemClient().getActorRaw(id);
    }

    public getSystemAdapter() {
        return systemService.getSystemClient().getSystemAdapter();
    }

    public async getSystemConfig(): Promise<any> {
        return systemService.getSystemClient().getSystemConfig();
    }

    private setupDocumentListeners(socket: any) {
        socket.on('modifyDocument', (data: any) => {
            // Combat & Combatant relay — preserved until Phase 5 introduces CombatStore.
            if (data.type === 'Combat' || data.type === 'Combatant') {
                logger.debug(`ClientSocket | Relay: Combat modification [${data.action}] for ${this.userId}`);
                this.emit('combatUpdate', data);
            }

            // ChatMessage relay removed — Phase 1 routes chat events through ChatMessageStore
            // → SystemService bridge → AppSocketGateway with ownership filtering.

            // Actor cache updates are relayed from the system ActorStore path so
            // per-user sockets do not duplicate actorUpdate emissions.

            // User relay (triggers dashboard systemStatus updates)
            if (data.type === 'User') {
                this.emit('systemStatusUpdate');
            }
        });

        // Engagement relay
        socket.on('userConnected', () => this.emit('systemStatusUpdate'));
        socket.on('userDisconnected', () => this.emit('systemStatusUpdate'));
        socket.on('userActivity', () => this.emit('systemStatusUpdate'));

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
