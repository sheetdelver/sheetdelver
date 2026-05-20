
import { io, Socket } from 'socket.io-client';
import { SocketBase } from './SocketBase';
import { logger } from '@shared/utils/logger';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { WorldData, CacheData, SetupManager } from '../../world/SetupManager';
import { FoundryConfig } from '../types';
import { CompendiumCache, compendiumStore } from '@server/core/compendium';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { userPresence } from '@server/core/documents/primary/users/UserPresence';
import { modifyDocumentRouter } from '@server/core/documents/primary/base/modifyDocumentRouter';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { worldLifecycleStore, type WorldLifecycleState } from '@server/core/world/WorldLifecycleStore';
import { sharedContentStore } from '@server/core/world/SharedContentStore';
import { engagementService, type WorldBootstrapSnapshot } from '@server/services/world';
// Side-effect import: registers Stores with the coordinator and router.
import '@server/core/documents/primary/PrimaryDocumentCacheCoordinator';
import fs from 'node:fs/promises';
import path from 'node:path';


export class CoreSocket extends SocketBase {
    private setWorldState(next: WorldLifecycleState, reason: string): void {
        worldLifecycleStore.setState(next, reason);
    }

    // ADR-0014 Phase 1: these legacy mirrors remain for CoreSocket internals
    // and compendium/bootstrap code during the transition. WorldStateStore is
    // the authoritative read model for routes/services/new code.
    public cachedWorldData: WorldData | null = null;
    public cachedWorlds: Record<string, WorldData> = {};
    public gameDataCache: any = null;
    public sceneDataCache: any = null;
    public userId: string | null = null;

    /**
     * World data discovered via the guest probe step.
     * Populated when the probe succeeds but the service account login fails.
     * Used to surface world title/description to the UI in 'world-closed' state.
     * Cleared once a full socket connection is established.
     */
    public probeWorldData: any = null;

    /**
     * Count of users discovered during the guest probe. Used by the status
     * payload when the world is discovered but Sheet Delver can't fully connect
     * (UserStore is not yet seeded in that state).
     */
    public probeUserCount: number = 0;

    // Core Socket maintains the singular connection
    private consecutiveFailures = 0;
    private retryCount = 0;

    private _routeModifyDocument(type: string, action: string, result: any, operation?: any) {
        // Single inbound dispatch point — routes to whichever Store handles
        // this type. After ADR-0011 Phase 7 every modeled primary document is
        // routed (Actor / Item / ActiveEffect → ActorStore + ItemStore;
        // ChatMessage → ChatMessageStore; Folder → FolderStore; User → UserStore;
        // JournalEntry / JournalEntryPage → JournalStore; Combat / Combatant →
        // CombatStore; RollTable / RollTableResult → RollTableStore;
        // Macro → MacroStore; Playlist / PlaylistSound → PlaylistStore;
        // Cards / Card → CardsStore). The Sheet-Delver-unused types (Scene /
        // FogExploration / Adventure / Setting) have stub Stores but no
        // router registration — events for them drop silently. Synthetic
        // tokens like `ActorDelta` similarly drop silently.
        modifyDocumentRouter.route({
            type,
            action: action as 'get' | 'create' | 'update' | 'delete',
            result,
            operation,
        });
    }


    constructor(config: any) {
        super(config);
        // ADR-0017 Phase 2: engagement policy lives in EngagementService.
        // CoreSocket only supplies the raw transport operations it may request.
        engagementService.setTransportCallbacks({
            resetRetryBackoff: () => {
                this.retryCount = 0;
            },
            startHeartbeat: (immediate = false) => {
                this.startHeartbeat(immediate);
            },
            getReconnectInputs: () => ({
                lifecycleState: worldLifecycleStore.getState(),
                isConnecting: this.isConnecting,
            }),
            reconnect: () => this.connect(),
        });
        this.loadInitialCache();
    }

    private clearActiveWorldCompendiumState(reason: string): void {
        // ADR-0015 Phase 2: Pathway A indices and the UUID-name cache describe
        // the active world only. Persistent Pathway B shards are left alone.
        compendiumStore.clear(reason);
        CompendiumCache.getInstance().reset();
    }

    private async loadInitialCache() {
        try {
            const cache = await SetupManager.loadCache();
            this.cachedWorlds = cache.worlds || {};
            if (cache.currentWorldId && this.cachedWorlds[cache.currentWorldId]) {
                this.cachedWorldData = this.cachedWorlds[cache.currentWorldId];
            }
            // Seed setup-mode cache into the Store so status/setup routes do
            // not need to read these transitional socket fields.
            worldStateStore.setCachedWorlds(cache);
        } catch (e) {
            logger.warn('CoreSocket | Failed to load initial cache: ' + e);
        }
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

    public async getBootstrapSnapshot(): Promise<WorldBootstrapSnapshot | null> {
        logger.info('CoreSocket | Fetching game data via socket for bootstrap...');
        const gameData = await this.getWorldData();
        if (!gameData) return null;

        const sceneData = await this.fetchSceneData(gameData);
        this.gameDataCache = gameData;
        this.sceneDataCache = sceneData;
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


    private isConnecting = false;
    async connect(): Promise<void> {
        // Only return if we are fully active. If we are in setup/offline, we should allow re-checks.
        if (this.isConnected && worldLifecycleStore.isState('active')) return;
        if (this.isConnecting) return;

        this.stopHeartbeat(); // Ensure clean slate
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
                this.setWorldState('setup', 'handshake-setup-or-gray');
                
                // Fast-Retry logic: Steady 1s detection for the first 30 seconds, then decay
                let backoffMs = 5000 * Math.pow(2, Math.min(this.retryCount - 30, 4));
                if (this.retryCount < 30) {
                    backoffMs = 1000;
                    if (this.retryCount % 5 === 0 || this.retryCount < 5) {
                        logger.info(`CoreSocket | World in Setup/Gray State. Fast-Retrying in 1s... (${this.retryCount + 1}/30)`);
                    }
                } else {
                    logger.info(`CoreSocket | World in Setup/Gray State. Backing off for ${backoffMs/1000}s... (Retry: ${this.retryCount})`);
                }
                
                backoffMs = Math.min(60000, backoffMs);
                
                this.retryCount++;
                setTimeout(() => this.connect(), backoffMs);
                return;
            }

            // If we have a specific world title, transition to STARTUP immediately to give UI feedback
            // This happens before the potentially slow Probe/Login steps.
            if (pageTitle && !isGenericOrErrorTitle && !worldLifecycleStore.isState('active')) {
                this.setWorldState('startup', 'handshake-world-title-detected');
                logger.info(`CoreSocket | World Detected (${pageTitle}). Transitioning to startup...`);
            }

            // 2. Discovery (Guest Probe)
            logger.info('CoreSocket | Probing world state (Guest Socket)...');
            const joinData = await this.probeWorldState(baseUrl);

            if (joinData && joinData.world) {
                logger.info(`CoreSocket | Discovered world "${joinData.world.title}" via Probe.`);
                // Stay in 'startup' — world is alive but we haven't completed
                // login or Sheet Delver bootstrap yet. `active` is written by
                // WorldBootstrapper only after Stores and the adapter are ready.
                this.setWorldState('startup', 'probe-world-discovered');
                this.probeWorldData = joinData.world;  // Cache for UI surface during recovery
                this.probeUserCount = Array.isArray(joinData.users) ? joinData.users.length : 0;
                // Probe data is pre-bootstrap state: enough for status UI when
                // the world exists but service-account login cannot complete.
                worldStateStore.setProbeData(joinData.world, this.probeUserCount);
                // Probe-time user data stays on the local joinData object — it's used
                // only for service-account name resolution (below). UserStore is seeded
                // by WorldBootstrapper after the main socket connects.
            } else {
                this.setWorldState('offline', 'probe-world-missing');

                // Fast-Retry logic: If we just disconnected, try 3 times 1s apart
                let backoffMs = 5000 * Math.pow(2, Math.min(this.retryCount, 4));
                if (this.retryCount < 3) {
                    backoffMs = 1000;
                    logger.warn(`CoreSocket | Discovery failed. Fast-Retrying in 1s... (${this.retryCount + 1}/3)`);
                } else {
                    logger.warn(`CoreSocket | Discovery failed. Backing off for ${backoffMs/1000}s... (Retry Count: ${this.retryCount})`);
                }
                
                backoffMs = Math.min(60000, backoffMs);
                
                this.retryCount++;
                setTimeout(() => this.connect(), backoffMs);
                return;
            }

            // Identify Service Account ID (Resolve ID from username). UserStore isn't
            // seeded yet at this point (the coordinator runs after the main socket connects),
            // so look up the service account directly from the probe's joinData.users.
            if (this.config.username) {
                const probeUsers: any[] = Array.isArray(joinData?.users) ? joinData.users : [];
                const user = probeUsers.find((u: any) => u.name === this.config.username);
                if (user) {
                    this.userId = user._id;
                    logger.info(`CoreSocket | Resolved Service Account ID: ${this.userId} (Username: ${this.config.username})`);
                } else {
                    // The world is running but the service account doesn't exist in it.
                    // Surface world info and halt retries until admin intervention.
                    const availableUsers = probeUsers.map((u: any) => `${u.name} (role: ${u.role})`).join(', ');
                    logger.error(`CoreSocket | Service account "${this.config.username}" not found in world "${this.probeWorldData?.title || 'unknown'}".\nAvailable users: [${availableUsers || 'none'}].\nWorld state set to 'closed'. No further retries until admin action.\nAdmin action required: Create or configure the service account in Foundry, then trigger a manual retry from the admin backend.`);
                    this.setWorldState('closed', 'service-account-missing');
                    // Optionally, emit an event or notify admin backend here
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
                    this.retryCount = 0; // Reset backoff on successful transport connection
                    this.setupSharedContentListeners(this.socket!);

                    // 5. Verify World Status
                    const isActive = await this.getWorldStatus();
                    if (!isActive) {
                        logger.warn('CoreSocket | Socket connected but world is NOT active.');
                        this.setWorldState('setup', 'socket-connected-world-not-active');
                        this.gameDataCache = null; // Clear potential stale cache
                        this.sceneDataCache = null; // Clear scene cache
                        worldStateStore.clearRuntimeState('world-setup');
                        // Shared content is active-world presentation state; clear it
                        // with the runtime snapshot so browser clients don't replay
                        // content from a previous world/session after setup.
                        sharedContentStore.clear('world-setup');
                        this.clearActiveWorldCompendiumState('world-setup');
                        userPresence.clear();
                        userStore.clear('world-setup');
                        clearTimeout(timeout);
                        // Still emit connect for setup mode to release the bootstrap lock
                        this.emit('connect');
                        resolve();
                        return;
                    }

                    logger.info('CoreSocket | Foundry world is ACTIVE. Handing application bootstrap to WorldBootstrapper...');
                    this.setWorldState('startup', 'foundry-world-active');
                    this.probeWorldData = null;  // Full connection established; probe cache no longer needed
                    this.probeUserCount = 0;
                    worldStateStore.clearProbeData();

                    clearTimeout(timeout);
                    this.emit('connect');
                    resolve();
                });

                this.socket.on('disconnect', (reason: string) => {
                    logger.info(`CoreSocket | Socket Disconnected: ${reason}`);
                    this.isSocketConnected = false;
                    this.stopHeartbeat();
                    this.retryCount = 0; // CRITICAL: Reset backoff to ensure immediate re-probe on world launch/transition
                    
                    // Don't overwrite setup state if we manually triggered it via heartbeat
                    if (!worldLifecycleStore.isState('setup')) {
                        this.setWorldState('offline', 'socket-disconnect');
                    }
                    this.gameDataCache = null; // Clear cache to prevent stale data
                    this.sceneDataCache = null; // Clear scene cache
                    // Preserve setup cache, but remove active-world/probe state.
                    worldStateStore.clearRuntimeState('core-disconnect');
                    sharedContentStore.clear('core-disconnect');
                    this.clearActiveWorldCompendiumState('core-disconnect');
                    userPresence.clear();
                    userStore.clear('core-disconnect');
                    this.emit('disconnect', reason);

                    // Immediate verification handshake if disconnect was unexpected
                    if (engagementService.shouldReconnectAfterUnexpectedDisconnect(reason)) {
                        this.connect();
                    }
                });

                this.socket.on('shutdown', () => {
                    logger.warn('CoreSocket | Native Shutdown signal received from Foundry. World is closing.');
                    this.setWorldState('setup', 'foundry-shutdown');
                    this.disconnect();
                    // Don't immediately reconnect if shutdown was graceful, wait for heartbeat to see when setup is live
                    this.startHeartbeat(true); 
                });

                this.socket.on('reload', () => {
                    logger.info('CoreSocket | Native Reload signal received from Foundry. State transition detected.');
                    this.retryCount = 0;
                    this.connect();
                });

                this.socket.on('progress', (data: any) => {
                    if (data?.action === 'launchWorld' && data?.step === 'complete') {
                        logger.warn('CoreSocket | Native Progress signal: World Launch Complete. Reconnecting immediately...');
                        this.retryCount = 0;
                        this.connect();
                    }
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

                // User Presence & Activity Listeners — touch the ephemeral presence map only.
                // The User document itself is mutated through the modifyDocument router into UserStore.
                this.socket.on('userConnected', (user: any) => {
                    const id = user._id || user.id;
                    logger.info(`CoreSocket | User connected: ${user.name} (${id})`);
                    if (userPresence.setActive(id, true)) {
                        this.emit('systemStatusUpdate');
                    }
                });

                this.socket.on('userDisconnected', (data: any) => {
                    const id = typeof data === 'string' ? data : (data.userId || data._id || data.id);
                    logger.info(`CoreSocket | User disconnected: ${id}`);
                    if (userPresence.setActive(id, false)) {
                        this.emit('systemStatusUpdate');
                    }
                });

                this.socket.on('userActivity', (userId: string, data: any) => {
                    if (userId && data) {
                        const isActive = data.active !== false;
                        if (userPresence.setActive(userId, isActive)) {
                            this.emit('systemStatusUpdate');
                        }
                    }
                });

                this.socket.on('modifyDocument', (data: any) => {
                    // All Document mutations route through the modifyDocument router. Each type's
                    // Store handles its own apply path and emits the right events.
                    // Legacy chat/combat app-event emissions are retired; Stores own fan-out.
                    this._routeModifyDocument(data.type, data.action, data.result, data.operation);
                });

                // Legacy/Module compatibility listeners — older Foundry versions and some modules
                // emit these alongside modifyDocument. Route through the same path; the Store's
                // emit-only-on-observable-change rule keeps duplicate applies idempotent.
                this.socket.on('createUser', (user: any) => {
                    this._routeModifyDocument('User', 'create', [user]);
                });
                this.socket.on('updateUser', (user: any) => {
                    this._routeModifyDocument('User', 'update', [user]);
                });
                this.socket.on('deleteUser', (id: string | any) => {
                    const userId = typeof id === 'string' ? id : (id?._id || id?.id);
                    if (!userId) return;
                    logger.info(`CoreSocket | User deleted: ${userId}`);
                    this._routeModifyDocument('User', 'delete', null, { ids: [userId] });
                    if (userPresence.delete(userId)) {
                        this.emit('systemStatusUpdate');
                    }
                });
            });

        } catch (error: unknown) {
            logger.error(`CoreSocket | Connection flow failed: ${getErrorMessage(error)}`);
            this.setWorldState('offline', 'connection-flow-failed');
            // Retry on error
            setTimeout(() => this.connect(), 5000);
        } finally {
            this.isConnecting = false;
        }
    }


    private heartbeatInterval: ReturnType<typeof setTimeout> | null = null;

    private startHeartbeat(immediate: boolean = false) {
        if (this.heartbeatInterval) clearTimeout(this.heartbeatInterval);

        const runHeartbeat = async () => {
            // Heartbeat can run while disconnected IF we are in setup or offline (acting as a Probe)
            const worldState = worldLifecycleStore.getState();
            const canProbe = worldState === 'setup' || worldState === 'offline';
            if (!engagementService.shouldRunHeartbeat({
                isConnected: this.isConnected,
                isConnecting: this.isConnecting,
                lifecycleState: worldState,
            })) return;
            
            try {
                const { isSetupMatch, csrfToken, pageTitle } = await this.performHandshake(this.getBaseUrl());
                const isGenericOrErrorTitle = !pageTitle || pageTitle === 'Foundry Virtual Tabletop' || pageTitle.includes('Critical Failure');

                // If we were in setup/offline but now see a real world title, trigger connect immediately
                if (canProbe && pageTitle && !isGenericOrErrorTitle) {
                    logger.info(`CoreSocket | Heartbeat detected world lifecycle change (Title="${pageTitle}"). waking up...`);
                    this.retryCount = 0;
                    this.connect();
                    return;
                }

                if (isSetupMatch || (!csrfToken && isGenericOrErrorTitle)) {
                    // Only log transition if we weren't already aware we were in Setup
                    if (!worldLifecycleStore.isState('setup')) {
                        logger.warn(`CoreSocket | Heartbeat detected transition to Setup/Gray State (Title="${pageTitle}"). Restarting connection flow...`);
                        this.setWorldState('setup', 'heartbeat-setup-or-gray');
                        this.disconnect();
                        this.connect();
                        return;
                    }
                }
            } catch (e) {
                // Ignore transient network errors
            }

            // Schedule next heartbeat with adaptive timing
            if (this.heartbeatInterval !== null) {
                const nextInterval = engagementService.getNextHeartbeatDelayMs();
                this.heartbeatInterval = setTimeout(runHeartbeat, nextInterval);
            }
        };

        // Start the recursive timeout chain
        this.heartbeatInterval = setTimeout(runHeartbeat, engagementService.getInitialHeartbeatDelayMs(immediate));
    }

    private stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearTimeout(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    public async withHeartbeatPaused<T>(operation: () => Promise<T>): Promise<T> {
        // Compendium pack scans can be slow enough to trip the heartbeat loop.
        // The route/compendium transport shape stays stable, while the pause
        // state itself is owned by EngagementService.
        return engagementService.withHeartbeatPaused(operation);
    }

    public startRuntimeHeartbeat(): void {
        this.startHeartbeat();
    }

    public disconnect() {
        this.stopHeartbeat();
        this.isConnecting = false;
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
            this.isSocketConnected = false;

            // Only drop to offline if we haven't explicitly transitioned to setup
            if (!worldLifecycleStore.isState('setup')) {
                this.setWorldState('offline', 'explicit-disconnect');
            }

            this.gameDataCache = null;
            this.sceneDataCache = null;
            worldStateStore.clearRuntimeState('core-disconnect');
            sharedContentStore.clear('core-disconnect');
            this.clearActiveWorldCompendiumState('core-disconnect');
            userPresence.clear();
            userStore.clear('core-disconnect');
            actorStore.clear('core-disconnect');
            logger.info('CoreSocket | Explicitly disconnected.');
        }
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

            // Proactive cache update (initiator confirmation). The router fan-outs to
            // whichever Store handles this type. Broadcast that follows is idempotent
            // via each Store's emit-only-on-change rule.
            if (result) {
                this._routeModifyDocument(type, action, result.result, result.operation || operation);
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

    // Admin / World Control
    public async launchWorld(worldId: string) { /* ... */ }
    public async shutdownWorld() { /* ... */ }

    async evaluate<T>(): Promise<T> {
        return worldStateStore.getGameDataSnapshot() as T;
    }
}
