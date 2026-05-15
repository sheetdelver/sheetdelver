
import { io, Socket } from 'socket.io-client';
import { SocketBase } from './SocketBase';
import { logger } from '@shared/utils/logger';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { WorldData, CacheData, SetupManager } from '../SetupManager';
import { FoundryConfig } from '../types';
import { FoundryMetadataClient } from '../interfaces';
import { getAdapter } from '@modules/registry/server';
import { SystemAdapter } from '@modules/registry/types';
import { CompendiumCache } from '../compendium-cache';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { modifyDocumentRouter } from '@server/core/documents/primary/base/modifyDocumentRouter';
// Side-effect import: registers Stores with the coordinator and router.
import '@server/core/documents/primary/PrimaryDocumentCacheCoordinator';
import { DOCUMENT_VISIBILITY, FoundryUserRole, createDocumentAccessSubject } from '@server/core/documents/primary/base/ownership';
import { PrimaryDocumentCacheNotReadyError } from '@server/core/documents/primary/errors';
import fs from 'node:fs/promises';
import path from 'node:path';


export class CoreSocket extends SocketBase implements FoundryMetadataClient {
    public worldState: 'offline' | 'setup' | 'startup' | 'active' | 'closed' = 'offline';
    public cachedWorldData: WorldData | null = null;
    public cachedWorlds: Record<string, WorldData> = {};
    private adapter: SystemAdapter | null = null;
    public gameDataCache: any = null;
    public sceneDataCache: any = null;
    public userId: string | null = null;
    public lastActorChange: number = Date.now();

    /**
     * World data discovered via the guest probe step.
     * Populated when the probe succeeds but the service account login fails.
     * Used to surface world title/description to the UI in 'world-closed' state.
     * Cleared once a full socket connection is established.
     */
    public probeWorldData: any = null;

    // Core Socket maintains the singular connection
    private consecutiveFailures = 0;
    private lastLaunchActivity = 0;
    private heartbeatPaused = false;
    private userMap = new Map<string, any>();
    private retryCount = 0;
    private activeBrowserCount = 0;
    private lastUserActivityTimestamp = Date.now();

    private _routeModifyDocument(type: string, action: string, result: any, operation?: any) {
        // Single inbound dispatch point — routes to whichever Store handles
        // this type (Actor/Item/ActiveEffect → ActorStore; ChatMessage → ChatMessageStore;
        // unrouted types like ActorDelta/Macro/Playlist drop silently).
        modifyDocumentRouter.route({
            type,
            action: action as 'get' | 'create' | 'update' | 'delete',
            result,
            operation,
        });

        if (action === 'create' || action === 'update' || action === 'delete') {
            if (type === 'Actor' || type === 'Item') {
                this.lastActorChange = Date.now();
            }
        }
    }


    constructor(config: any) {
        super(config);
        this.loadInitialCache();
    }

    private async loadInitialCache() {
        try {
            const cache = await SetupManager.loadCache();
            this.cachedWorlds = cache.worlds || {};
            if (cache.currentWorldId && this.cachedWorlds[cache.currentWorldId]) {
                this.cachedWorldData = this.cachedWorlds[cache.currentWorldId];
            }
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
    private async fetchSceneData(): Promise<any> {
        if (!this.socket || !this.socket.connected) return null;
        try {
            // Scenes are already included in the world data
            const worldData = await this.getWorldData();
            if (worldData && worldData.scenes) {
                // Convert scenes array to map by ID for easier lookup
                const sceneMap: any = {};
                worldData.scenes.forEach((scene: any) => {
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


    private isConnecting = false;

    /**
     * Update the count of active browser clients and reset the heartbeat/backoff.
     */
    public updateActiveBrowserCount(count: number) {
        const previousCount = this.activeBrowserCount;
        this.activeBrowserCount = count;
        
        if (count > 0) {
            this.lastUserActivityTimestamp = Date.now();
            
            // If we're transitioning from 0 to >0 users, wake up immediately
            if (previousCount === 0) {
                logger.debug('CoreSocket | User engagement detected. Waking up heartbeat.');
                this.retryCount = 0; // Reset backoff
                this.startHeartbeat(true); // Immediate trigger
                
                // If we were offline/setup, try connecting right now
                if (this.worldState !== 'active' && !this.isConnecting) {
                    this.connect();
                }
            }
        }
    }


    async connect(): Promise<void> {
        // Only return if we are fully active. If we are in setup/offline, we should allow re-checks.
        if (this.isConnected && this.worldState === 'active') return;
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
                this.worldState = 'setup';
                
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
            if (pageTitle && !isGenericOrErrorTitle && this.worldState !== 'active') {
                this.worldState = 'startup';
                logger.info(`CoreSocket | World Detected (${pageTitle}). Transitioning to startup...`);
            }

            // 2. Discovery (Guest Probe)
            logger.info('CoreSocket | Probing world state (Guest Socket)...');
            const joinData = await this.probeWorldState(baseUrl);

            if (joinData && joinData.world) {
                logger.info(`CoreSocket | Discovered world "${joinData.world.title}" via Probe.`);
                // Stay in 'startup' — world is alive but we haven't completed login yet.
                // Do NOT set 'active' here; that only happens after the socket connects
                // and getWorldStatus() confirms the world is fully active.
                this.worldState = 'startup';
                this.probeWorldData = joinData.world;  // Cache for UI surface during recovery
                // Update Cache and User Map
                if (joinData.users) {
                    joinData.users.forEach((u: any) => this.userMap.set(u._id, u));
                }
            } else {
                this.worldState = 'offline';

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

            // Identify Service Account ID (Resolve ID from username)
            if (this.config.username) {
                const user = Array.from(this.userMap.values()).find((u: any) => u.name === this.config.username);
                if (user) {
                    this.userId = user._id;
                    logger.info(`CoreSocket | Resolved Service Account ID: ${this.userId} (Username: ${this.config.username})`);
                } else {
                    // The world is running but the service account doesn't exist in it.
                    // Surface world info and halt retries until admin intervention.
                    const availableUsers = Array.from(this.userMap.values()).map((u: any) => `${u.name} (role: ${u.role})`).join(', ');
                    logger.error(`CoreSocket | Service account "${this.config.username}" not found in world "${this.probeWorldData?.title || 'unknown'}".\nAvailable users: [${availableUsers || 'none'}].\nWorld state set to 'closed'. No further retries until admin action.\nAdmin action required: Create or configure the service account in Foundry, then trigger a manual retry from the admin backend.`);
                    this.worldState = 'closed'; // New state for unavailable world
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
                        this.worldState = 'setup';
                        this.gameDataCache = null; // Clear potential stale cache
                        this.sceneDataCache = null; // Clear scene cache
                        this.userMap.clear();
                        clearTimeout(timeout);
                        // Still emit connect for setup mode to release the bootstrap lock
                        this.emit('connect');
                        resolve();
                        return;
                    }

                    logger.info('CoreSocket | World is ACTIVE. Fetching game data via socket...');
                    this.worldState = 'active';
                    this.probeWorldData = null;  // Full connection established; probe cache no longer needed

                    // 6. Fetch Game Data via Socket (The canonical bootstrap way)
                    const gameData = await this.getWorldData();
                    const sceneData = await this.fetchSceneData();

                    // 7. Start Heartbeat ONLY after bootstrapping is complete
                    this.startHeartbeat();
                    // DEFERRED: We no longer emit 'connect' here, as gameDataCache isn't set yet.
                    // This prevents bootstrapping races.
                    if (gameData) {
                        this.gameDataCache = gameData;
                        if (sceneData) {
                            this.sceneDataCache = sceneData;
                            logger.info('CoreSocket | Scene Data cached');
                        } else {
                            logger.warn('CoreSocket | Scene data unavailable');
                        }
                        if (gameData.users) {
                            const activeIds = gameData.activeUsers || [];
                            gameData.users.forEach((u: any) => {
                                const isActive = activeIds.includes(u._id || u.id);
                                const userData = { ...u, active: isActive };
                                this.userMap.set(u._id || u.id, userData);
                            });
                            // Sync the cache array as well
                            gameData.users = gameData.users.map((u: any) => ({
                                ...u,
                                ...this.userMap.get(u._id || u.id),
                                active: activeIds.includes(u._id || u.id)
                            }));
                        }
                        if (gameData.userId) {
                            this.userId = gameData.userId;
                        }

                        const systemId = gameData.system?.id || gameData.system?.name;
                        if (systemId) {
                            await this.loadSystemAdapter(systemId);
                        }
                        logger.info(`CoreSocket | Game Data Loaded via Socket (User: ${this.userId})`);
                    } else {
                        logger.error('CoreSocket | Failed to fetch game data via socket event (session.getData).');
                    }

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
                    if (this.worldState !== 'setup') {
                        this.worldState = 'offline';
                    }
                    this.gameDataCache = null; // Clear cache to prevent stale data
                    this.sceneDataCache = null; // Clear scene cache
                    this.userMap.clear();
                    this.emit('disconnect', reason);

                    // Immediate verification handshake if disconnect was unexpected
                    if (reason !== 'io client disconnect' && this.activeBrowserCount > 0) {
                        this.connect();
                    }
                });

                this.socket.on('shutdown', () => {
                    logger.warn('CoreSocket | Native Shutdown signal received from Foundry. World is closing.');
                    this.worldState = 'setup';
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

                // User Presence & Activity Listeners
                this.socket.on('userConnected', (user: any) => {
                    const id = user._id || user.id;
                    logger.info(`CoreSocket | User connected: ${user.name} (${id})`);
                    this.updateUserInCache(id, { ...user, active: true });
                });

                this.socket.on('userDisconnected', (data: any) => {
                    const id = typeof data === 'string' ? data : (data.userId || data._id || data.id);
                    logger.info(`CoreSocket | User disconnected: ${id}`);
                    this.updateUserInCache(id, { active: false });
                });

                this.socket.on('userActivity', (userId: string, data: any) => {
                    if (userId && data) {
                        const isActive = data.active !== false;
                        this.updateUserInCache(userId, { active: isActive });
                    }
                });

                this.socket.on('modifyDocument', (data: any) => {
                    if (data.type === 'User' && (data.action === 'update' || data.action === 'create')) {
                        const users = data.result || [];
                        users.forEach((u: any) => {
                            const id = u._id || u.id;
                            if (id) {
                                this.updateUserInCache(id, u);
                            }
                        });
                    }
                    else {
                        // Route to per-type Store via the modifyDocument router.
                        // ChatMessage / Actor / Item / ActiveEffect changes flow into their respective
                        // Stores, which emit documentChanged / documentListInvalidated events.
                        this._routeModifyDocument(data.type, data.action, data.result, data.operation);

                        // Combat still uses the bespoke per-type emit until Phase 5 introduces CombatStore.
                        if (data.type === 'Combat' || data.type === 'Combatant') {
                            logger.debug(`CoreSocket | Combat modification detected: ${data.type} ${data.action}`);
                            this.emit('combatUpdate', data);
                        }

                        // chatUpdate emission removed — ChatMessage events flow through ChatMessageStore.
                    }
                });

                // Legacy/Module Compatibility Listeners
                this.socket.on('createUser', (user: any) => this.updateUserInCache(user._id || user.id, user));
                this.socket.on('updateUser', (user: any) => this.updateUserInCache(user._id || user.id, user));
                this.socket.on('deleteUser', (id: string | any) => {
                    const userId = typeof id === 'string' ? id : (id._id || id.id);
                    logger.info(`CoreSocket | User deleted: ${userId}`);
                    this.userMap.delete(userId);
                    if (this.gameDataCache && Array.isArray(this.gameDataCache.users)) {
                        this.gameDataCache.users = this.gameDataCache.users.filter((u: any) => (u._id !== userId && u.id !== userId));
                    }
                });
            });

        } catch (error: unknown) {
            logger.error(`CoreSocket | Connection flow failed: ${getErrorMessage(error)}`);
            this.worldState = 'offline';
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
            const canProbe = this.worldState === 'setup' || this.worldState === 'offline';
            if ((!this.isConnected && !canProbe) || this.isConnecting || this.worldState === 'startup' || this.heartbeatPaused) return;
            
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
                    if (this.worldState !== 'setup') {
                        logger.warn(`CoreSocket | Heartbeat detected transition to Setup/Gray State (Title="${pageTitle}"). Restarting connection flow...`);
                        this.worldState = 'setup';
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
                let nextInterval = 5000; // High frequency default: 5s
                
                if (this.activeBrowserCount === 0) {
                    const idleTime = Date.now() - this.lastUserActivityTimestamp;
                    
                    if (idleTime > 1800000) { // > 30m
                        nextInterval = 120000; // 2m
                    } else if (idleTime > 600000) { // > 10m
                        nextInterval = 60000; // 1m
                    } else {
                        nextInterval = 30000; // 30s
                    }
                }
                
                this.heartbeatInterval = setTimeout(runHeartbeat, nextInterval);
            }
        };

        // Start the recursive timeout chain
        this.heartbeatInterval = setTimeout(runHeartbeat, immediate ? 0 : 5000);
    }

    private stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearTimeout(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    public disconnect() {
        this.stopHeartbeat();
        this.isConnecting = false;
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
            this.isSocketConnected = false;

            // Only drop to offline if we haven't explicitly transitioned to setup
            if (this.worldState !== 'setup') {
                this.worldState = 'offline';
            }

            this.gameDataCache = null;
            this.sceneDataCache = null;
            this.userMap.clear();
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

    public async getPackEntries(packId: string, options: any = { index: true }): Promise<any[]> {
        logger.debug(`CoreSocket | Fetching entries for pack ${packId} (options: ${JSON.stringify(options)})...`);
        this.heartbeatPaused = true;
        
        try {
            // Strategy 1: Unified modifyDocument API (The CRUD-master V13 approach - PROVEN WINNER)
            try {
                logger.debug(`[CoreSocket] [TRACE] getPackEntries Strategy 1 (modifyDocument): ${packId}`);
                const response: any = await this.emitSocketEvent('modifyDocument', {
                    type: packId.includes('tables') ? 'RollTable' : 'Item',
                    action: 'get',
                    operation: { 
                        pack: packId, 
                        index: true,
                        fields: options.fields || []
                    }
                }, 5000);
                if (response?.result && Array.isArray(response.result)) return response.result;
            } catch (e) {
                // Trial fallback
            }

            // Strategy 2: Modern getDocuments with index flag (Canonical V13)
            try {
                logger.debug(`[CoreSocket] [TRACE] getPackEntries Strategy 2 (getDocuments): ${packId}`);
                const response: any = await this.emitSocketEvent('getDocuments', packId.includes('tables') ? 'RollTable' : 'Item', { 
                    index: true, 
                    pack: packId,
                    fields: options.fields || []
                }, 5000);
                if (response?.result && Array.isArray(response.result)) return response.result;
            } catch (e) {
                // Trial fallback
            }

            // Strategy 3: Legacy getCompendiumIndex (V11/V12 Alias)
            try {
                logger.debug(`[CoreSocket] [TRACE] getPackEntries Strategy 3 (getCompendiumIndex): ${packId}`);
                const response: any = await this.emitSocketEvent('getCompendiumIndex', packId, 5000);
                if (Array.isArray(response)) return response;
                if (response?.result && Array.isArray(response.result)) return response.result;
            } catch (e) {
                // Trial fallback
            }

            logger.error(`CoreSocket | All entry fetch strategies failed for pack ${packId}`);
            return [];
        } finally {
            this.heartbeatPaused = false;
        }
    }

    public async getPackIndex(packId: string, type: string): Promise<any[]> {
        try {
            logger.debug(`CoreSocket | Fetching index for pack ${packId} (type: ${type})...`);

            // Try 1: getCompendiumIndex (v12/v13)
            // String payload is the preferred v13 way
            try {
                const response: any = await this.emitSocketEvent('getCompendiumIndex', packId, 3000);
                if (Array.isArray(response)) {
                    return response;
                }
                if (response?.result && Array.isArray(response.result)) {
                    return response.result;
                }
            } catch (e) {
                // Silently fallback
            }

            // Try 2: getDocuments (v13 Standard)
            // Try both singular and plural (v13 often prefers plural collection names)
            const typesToTry = [type];
            if (type === 'RollTable') typesToTry.push('Tables', 'RollTables');
            else if (type === 'Item') typesToTry.push('Items');
            else if (type === 'JournalEntry') typesToTry.push('Journal');

            for (const t of typesToTry) {
                try {
                    const response: any = await this.emitSocketEvent('getDocuments', {
                        type: t,
                        operation: { pack: packId, index: true }
                    }, 2000);
                    if (response?.result && Array.isArray(response.result)) {
                        return response.result;
                    }
                } catch (e) {
                    // Try next type
                }
            }

            // Fallback: modifyDocument (Legacy)
            try {
                const response: any = await this.dispatchDocumentSocket(type, 'get', {
                    pack: packId,
                    index: true,
                    broadcast: false
                }, undefined, false); // Do not fail hard on this
                const finalIndex = response?.result || [];
                if (finalIndex.length > 0) {
                    return finalIndex;
                }
            } catch (_e) {
                // Ignore packData errors
            }

            return [];
        } catch (e) {
            logger.warn(`CoreSocket | getPackIndex failed for ${packId}: ${e}`);
            return [];
        }
    }

    public async getPackDocuments(packId: string, type: string): Promise<any[]> {
        try {
            logger.debug(`CoreSocket | Fetching full documents for pack ${packId} (type: ${type})...`);

            const typesToTry = [type];
            if (type === 'RollTable') typesToTry.push('Tables', 'RollTables');
            else if (type === 'Item') typesToTry.push('Items');
            else if (type === 'JournalEntry') typesToTry.push('JournalEntries', 'Journal');
            else if (type === 'Actor') typesToTry.push('Actors');

            for (const t of typesToTry) {
                try {
                    const response: any = await this.emitSocketEvent('getDocuments', {
                        type: t,
                        operation: { pack: packId }
                    }, 5000);
                    if (response?.result && Array.isArray(response.result)) {
                        return response.result;
                    }
                } catch (e) {
                    // Try next type
                }
            }

            // Fallback: modifyDocument (Legacy)
            try {
                const response: any = await this.dispatchDocumentSocket(type, 'get', {
                    pack: packId,
                    broadcast: false
                }, undefined, false);
                const results = response?.result || [];
                if (results.length > 0) {
                    return results;
                }
            } catch (_e) {
                // Ignore errors
            }

            return [];
        } catch (e) {
            logger.warn(`CoreSocket | getPackDocuments failed for ${packId}: ${e}`);
            return [];
        }
    }

    public async getAllCompendiumIndices(onlyGamePacks: boolean = false): Promise<any[]> {
        if (!this.isConnected) return [];
        if (this.gameDataCache?.indices) return this.gameDataCache.indices; // Return cached if already available

        // Deduplication Guard
        const { CompendiumCache } = await import('../compendium-cache');
        if (CompendiumCache.getInstance().hasLoaded()) {
            // We still want to return the indices if they exist
            // But we need to make sure they are stored in gameDataCache or we re-fetch once and store.
            // For now, let's just let it run if not loaded, but we should eventually skip if already warming up.
        }

        try {
            const game = this.gameDataCache;
            if (!game) {
                logger.warn('CoreSocket | No gameData available for discovery.');
                return [];
            }
            logger.debug(`CoreSocket | gameData keys: ${Object.keys(game).join(', ')}`);
            if (game.packs) logger.debug(`CoreSocket | game.packs found, count: ${game.packs.length}`);

            const packs = new Map<string, any>();

            // 0. Top-level Packs (v12 style)
            if (Array.isArray(game.packs)) {
                game.packs.forEach((p: any) => {
                    const id = p.id || p._id;
                    if (id) packs.set(id, { ...p, source: 'game.packs' });
                });
            }

            // 1. Fallback Discovery (Aggregate from metadata)
            if (!onlyGamePacks) {
                // In v13 socket payloads ('world'), packs are usually nested here instead of top-level
                const worldPacks = game.world?.packs || [];
                const systemPacks = game.system?.packs || [];
                const modulePacks = Array.isArray(game.modules)
                    ? game.modules.flatMap((m: any) => (m.packs || []).map((p: any) => ({ ...p, moduleId: m.id })))
                    : [];

                const fallbackPacks = [
                    ...worldPacks.map((p: any) => ({ ...p, source: 'world' })),
                    ...systemPacks.map((p: any) => ({ ...p, source: 'system' })),
                    ...modulePacks.map((p: any) => ({ ...p, source: 'module' }))
                ];

                fallbackPacks.forEach((p: any) => {
                    // Try to derive a complete ID if only 'name' exists
                    const id = p.id || p._id || (p.moduleId ? `${p.moduleId}.${p.name}` : `${game.system?.id || 'system'}.${p.name}`);
                    if (!packs.has(id)) packs.set(id, p);
                });
            }
            logger.info(`CoreSocket | Discovering indices for ${packs.size} packs in parallel...`);
            const results = await Promise.all(Array.from(packs.entries()).map(async ([packId, metadata]) => {
                const docType = metadata.type || metadata.entity || metadata.documentName || 'Item';
                const index = await this.getPackIndex(packId, docType);
                return {
                    id: packId,
                    metadata: metadata,
                    index: index
                };
            }));

            logger.info(`CoreSocket | Compendium discovery complete (${results.length} packs indexed)`);
            if (this.gameDataCache) this.gameDataCache.indices = results;
            return results;
        } catch (e) {
            logger.warn(`CoreSocket | getAllCompendiumIndices failed: ${e}`);
            return [];
        }
    }

    // --- Public API methods (called by Endpoints) ---

    public getGameData() { return this.gameDataCache; }
    public getSceneData() { return this.sceneDataCache; }
    public getSystemAdapter() { return this.adapter; }

    public async getSystemConfig(): Promise<any> {
        // Return from cache if available
        if (this.gameDataCache?.system) {
            return this.gameDataCache.system;
        }

        // Otherwise, probe for it
        if (!this.socket || !this.socket.connected) return null;

        return new Promise((resolve) => {
            const t = setTimeout(() => resolve(null), 5000);
            this.socket!.emit('getSystemConfig', (config: any) => {
                clearTimeout(t);
                resolve(config);
            });
        });
    }

    public async loadSystemAdapter(systemId: string) {
        try {
            const { getMatchingAdapter } = await import('@modules/registry/server');
            const adapter = await getMatchingAdapter(systemId);
            if (adapter) {
                this.adapter = adapter;
                logger.info(`CoreSocket | Loaded System Adapter: ${systemId}`);
            }
        } catch (e) {
            logger.error(`CoreSocket | Failed load adapter: ${e}`);
        }
    }

    public async getCombats(): Promise<any[]> {
        const result: any = await this.dispatchDocumentSocket('Combat', 'get', { broadcast: false });
        return result?.result || [];
    }

    public async getJournals(userId?: string): Promise<any[]> {
        const result: any = await this.dispatchDocumentSocket('JournalEntry', 'get', { broadcast: false });
        const all = result?.result || [];
        if (!userId) return all;

        // Basic filtering for implicit User View
        // 0 = None, 1 = Limited, 2 = Observer, 3 = Owner
        // If no ownership[userId], check ownership['default']
        return all.filter((j: any) => {
            const level = j.ownership?.[userId] !== undefined ? j.ownership[userId] : (j.ownership?.default || 0);
            return level >= 2; // Observer or better
        });
    }

    public async getFolders(type?: string): Promise<any[]> {
        const result: any = await this.dispatchDocumentSocket('Folder', 'get', { broadcast: false });
        let all = result?.result || [];

        if (type) {
            all = all.filter((f: any) => f.type === type);
        }

        return all;
    }

    public async getActors(userId?: string): Promise<any[]> {
        if (!actorStore.isReady()) throw new PrimaryDocumentCacheNotReadyError('Actor');

        // Compatibility read surface: route clients now hit ActorStore first.
        if (!userId) return actorStore.list();
        const user = this.getUser(userId);
        const subject = createDocumentAccessSubject(userId, user?.role ?? FoundryUserRole.NONE);
        return subject
            ? actorStore.listActors({ subject, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE })
            : [];
    }

    public async getActor(id: string, forceSystemId?: string): Promise<any> {
        if (!actorStore.isReady()) throw new PrimaryDocumentCacheNotReadyError('Actor');

        // Privileged socket callers get the raw cached actor clone; route wrappers
        // perform user-scoped filtering before exposing actors to requests.
        return actorStore.get(id);
    }

    public async getActorRaw(id: string): Promise<any> {
        if (!actorStore.isReady()) throw new PrimaryDocumentCacheNotReadyError('Actor');

        // Raw actor reads are internal-only and bypass ownership filtering.
        return actorStore.get(id);
    }

    public async fetchByUuid(uuid: string): Promise<any> {
        if (!uuid || typeof uuid !== 'string') return null;

        try {
            logger.debug(`[CoreSocket] [TRACE] fetchByUuid START: ${uuid}`);

            // 1. World Document (e.g. Actor.ID, Item.ID)
            if (!uuid.startsWith('Compendium.')) {
                const [type, id] = uuid.split('.');
                if (type && id) {
                    if (type === 'Actor') {
                        if (!actorStore.isReady()) throw new PrimaryDocumentCacheNotReadyError('Actor');
                        return actorStore.get(id);
                    }
                    logger.debug(`[CoreSocket] [TRACE] fetchByUuid World Document: ${type} ${id}`);
                    const response = await this.dispatchDocumentSocket(type, 'get', { query: { _id: id }, broadcast: false });
                    return response?.result?.[0];
                }
                return null;
            }

            // 2. Compendium Document (Agnostically parse segments)
            const parts = uuid.split('.');
            if (parts.length < 4) return null;

            // Anatomy: Compendium.[PACK_VENDOR].[PACK_NAME].[OPTIONAL_TYPE].[ID]
            const id = parts.pop()!;
            const lastSegment = parts[parts.length - 1];
            
            // Heuristic for type: If the segment before ID starts with a Capital letter, it's likely the Type
            const hasTypeSegment = lastSegment.match(/^[A-Z]/);
            const typeFromUuid = hasTypeSegment ? lastSegment : null;
            
            // Pack ID is everything after 'Compendium' and before the ID (and Type if present)
            const packParts = hasTypeSegment ? parts.slice(1, -1) : parts.slice(1);
            const packId = packParts.join('.');


            // Extract type from UUID if possible (e.g., ...Item...)
            // Since we popped the ID from 'parts', the new last item IS the type segment (if present).
            const typeInUuid = (parts.length >= 2) ? parts[parts.length - 1] : null;
            
            // Core Foundry types that are valid roots for compendium lookups
            const coreTypes = ['Item', 'Actor', 'JournalEntry', 'RollTable', 'Scene', 'Macro', 'Playlist'];
            
            let typesToTry: string[] = [];
            if (typeInUuid && coreTypes.includes(typeInUuid)) {
                typesToTry = [typeInUuid];
            } else {
                typesToTry = ['Item', 'Actor', 'JournalEntry', 'RollTable'];
            }

            // Trial timeout: Tighten to 500ms for local speed
            const TRIAL_TIMEOUT = 500;

            for (const t of typesToTry) {
                    if (!this.isConnected) return null; // Bail fast if disconnected
                    
                    // Strategy 1: modifyDocument (The successful one in latest tests)
                    try {
                        logger.debug(`[CoreSocket] [TRACE] fetchByUuid Strategy 1 (modifyDocument): ${packId} ${t} ${id}`);
                        const resp: any = await this.emitSocketEvent('modifyDocument', {
                            type: t,
                            action: 'get',
                            operation: { pack: packId, ids: [id] }
                        }, TRIAL_TIMEOUT);
                        
                        const found = resp?.result?.find((d: any) => (d._id === id || d.uuid?.endsWith(id)));
                        if (found) return found;
                    } catch (e) {
                         // Fallback
                    }

                    // Strategy 2: Modern getDocuments (Backup)
                    try {
                        logger.debug(`[CoreSocket] [TRACE] fetchByUuid Strategy 2 (getDocuments): ${packId} ${t} ${id}`);
                        const resp: any = await this.emitSocketEvent('getDocuments', {
                            type: t,
                            operation: { pack: packId, ids: [id] }
                        }, TRIAL_TIMEOUT);
                        
                        // Verify result
                        const found = resp?.result?.find((d: any) => (d._id === id || d.uuid?.endsWith(id)));
                        if (found) return found;
                    } catch (e) {
                         // Fallback
                    }
                }

            logger.debug(`[CoreSocket] [TRACE] fetchByUuid FAILED: ${uuid}`);
            return null;
        } catch (error) {
            if (error instanceof PrimaryDocumentCacheNotReadyError) throw error;
            logger.error(`[CoreSocket] [TRACE] fetchByUuid CRITICAL ERROR: ${uuid}`, error);
            return null;
        }
    }

    async updateActor(id: string, data: any): Promise<any> {
        // Update uses 'updates' array in operation
        return await this.dispatchDocumentSocket('Actor', 'update', { updates: [{ _id: id, ...data }] });
    }

    async createActor(data: any): Promise<any> {
        // Normalize to array for 'data' field in socket operation
        const batch = Array.isArray(data) ? data : [data];
        const response = await this.dispatchDocumentSocket('Actor', 'create', { data: batch });
        // Return first document if single creation, otherwise full result array
        return Array.isArray(data) ? response?.result : response?.result?.[0];
    }

    async deleteActor(id: string): Promise<any> {
        // Delete uses 'ids' array in operation
        return await this.dispatchDocumentSocket('Actor', 'delete', { ids: [id] });
    }

    async dispatchDocument(type: string, action: string, operation?: any, parent?: { type: string, id: string }): Promise<any> {
        return await this.dispatchDocumentSocket(type, action, operation, parent);
    }

    async createActorItem(actorId: string, itemData: any): Promise<any> {
        // Normalize to array for 'data' field
        const batch = Array.isArray(itemData) ? itemData : [itemData];
        const response = await this.dispatchDocumentSocket('Item', 'create',
            { data: batch },
            { type: 'Actor', id: actorId }
        );
        // Return first ID if single creation, otherwise array of IDs/docs
        if (Array.isArray(itemData)) {
            return response?.result;
        }
        return response?.result?.[0]?._id;
    }

    async updateActorItem(actorId: string, itemData: any): Promise<any> {
        const { _id, id, ...updates } = itemData;
        const targetId = _id || id;
        return await this.dispatchDocumentSocket('Item', 'update',
            { updates: [{ _id: targetId, ...updates }] },
            { type: 'Actor', id: actorId }
        );
    }

    async deleteActorItem(actorId: string, itemId: string): Promise<any> {
        return await this.dispatchDocumentSocket('Item', 'delete',
            { ids: [itemId] },
            { type: 'Actor', id: actorId }
        );
    }

    public async getChatLog(limit = 100, userId?: string): Promise<any[]> {
        const response: any = await this.dispatchDocumentSocket('ChatMessage', 'get', { broadcast: false });
        const raw = response?.result || [];

        // 1. Sort Chronologically (Oldest -> Newest)
        // We do this BEFORE filtering to ensure we have the full context
        const sorted = [...raw].sort((a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0));

        // 2. Filter based on requesting user
        const filtered = sorted.filter((msg: any) => {
            if (!userId) return true; // Internal calls see all

            const requestingUser = userId ? this.userMap.get(userId) : null;
            const isGM = (requestingUser?.role || requestingUser?.permissions?.role || 0) >= 3;

            const whisper = msg.whisper || [];
            const isPublic = whisper.length === 0;
            const isAuthor = msg.author === userId;
            const isWhisperToMe = whisper.includes(userId);

            if (isPublic) return true;
            if (isGM) return true;
            if (isAuthor) return true;
            if (isWhisperToMe) return true;

            return false;
        });

        // 4. Slice to the most recent 'limit' messages
        const latest = filtered.slice(-limit);

        return latest.map((msg: any) => {
            const requestingUser = userId ? this.userMap.get(userId) : null;
            const isGM = (requestingUser?.role || requestingUser?.permissions?.role || 0) >= 3;

            // Support both stringified and object-based rolls
            const rolls = (msg.rolls || []).map((r: any) => {
                if (typeof r === 'string') {
                    try {
                        return JSON.parse(r);
                    } catch (e) {
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
            const author = this.userMap.get(msg.author);
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
    }

    public async sendMessage(content: string | any, userId?: string, options?: { rollMode?: string, speaker?: any }): Promise<any> {
        // If userId is provided, we try to create the message AS that user.
        // Since we are GM/Service, we can set 'author' to any user ID.
        const auth = userId || this.userId;
        if (!auth) throw new Error("Cannot send message: Author ID missing");

        const isRoll = typeof content !== 'string' && (content.rolls || content.type === 5);

        // NOTE: Foundry V13 ChatMessage.author must be a valid 16-character alphanumeric user ID.
        // Author is set BEFORE the content spread so it cannot be clobbered by any `author` field in content.
        const data: any = typeof content === 'string'
            ? { content, type: 1, author: auth }
            : { type: isRoll ? 5 : 1, author: auth, ...content };

        // Handle Speaker
        if (options?.speaker) {
            if (typeof options.speaker === 'string') {
                data.speaker = { alias: options.speaker };
            } else {
                data.speaker = options.speaker;
            }
        }

        // Handle Roll Mode
        if (options?.rollMode) {
            const modeData = await this.resolveRollMode(options.rollMode, auth);
            Object.assign(data, modeData);
        }

        return await this.dispatchDocumentSocket('ChatMessage', 'create', { data: [data] });
    }

    public async roll(formula: string, flavor?: string, options?: { userId?: string, rollMode?: string, speaker?: any, displayChat?: boolean, flags?: any }): Promise<any> {
        try {
            // Dynamic import to avoid circular dependencies if any (though Roll is standalone)
            const { Roll } = await import('../classes/Roll'); // Path check required
            const roll = new Roll(formula);
            await roll.evaluate();

            const displayChat = options?.displayChat !== false;
            const auth = options?.userId || this.userId;
            const chatData: any = {
                author: auth,
                content: String(roll.total),
                flavor: flavor,
                type: 5, // ROLL (standard Foundry ChatMessage type)
                rolls: [JSON.stringify(roll.toJSON())], // Explicit stringification for safe transport
                flags: options?.flags || {},
                sound: 'sounds/dice.wav' // Optional: generic sound
            };

            // Handle Speaker
            const speaker = options?.speaker;
            if (speaker) {
                if (typeof speaker === 'string') {
                    chatData.speaker = { alias: speaker };
                } else {
                    chatData.speaker = speaker;
                }
            }

            // Handle Roll Mode
            if (options?.rollMode) {
                const modeData = await this.resolveRollMode(options.rollMode, auth);
                Object.assign(chatData, modeData);
            }

            if (displayChat) {
                const response: any = await this.dispatchDocumentSocket('ChatMessage', 'create', { data: [chatData] });
                return response?.result?.[0];
            }

            // Return a synthetic message object if chat is suppressed
            return {
                ...chatData,
                _synthetic: true
            };
        } catch (error: unknown) {
            const msg = getErrorMessage(error);
            logger.error(`CoreSocket | Roll failed: ${msg}`);
            if (options?.displayChat !== false) {
                // Fallback to text message
                return await this.sendMessage(`Rolling ${formula}: ${flavor || ''} (Error: ${msg})`, options?.userId);
            }
            throw error;
        }
    }

    /*
    public async rollTable(options: string | any) {
        return this.roll("", "", options);
    }
    */

    /**
     * Resolve the whisper and blind flags based on the roll mode.
     * Uses standardized RollMode strings: publicroll, gmroll, blindroll, selfroll
     */
    private async resolveRollMode(mode: string, userId: string | null) {
        if (mode === 'publicroll') return {};
        if (mode === 'selfroll') return { whisper: userId ? [userId] : [] };

        // For blind/private/gm, we need GM users
        const users = await this.getUsers();
        // Role 4 is GM, 3 is Assistant GM
        const gmIds = users.filter((u: any) => (u.role || u.permissions?.role) >= 3).map((u: any) => u._id || u.id);

        // Include author (userId) in whisper array for non-blind rolls so they can see their own result
        const authorId = userId ? [userId] : [];

        if (mode === 'gmroll') return { whisper: Array.from(new Set([...gmIds, ...authorId])) };
        if (mode === 'blindroll') return { blind: true, whisper: gmIds };

        // Compatibility for legacy or other naming conventions
        if (mode === 'public') return {};
        if (mode === 'self') return { whisper: userId ? [userId] : [] };
        if (mode === 'gm') return { whisper: Array.from(new Set([...gmIds, ...authorId])) };
        if (mode === 'blind') return { blind: true, whisper: gmIds };
        if (mode === 'private') return { whisper: Array.from(new Set([...gmIds, ...authorId])) };

        return {};
    }


    async useItem(actorId: string, itemId: string): Promise<any> {
        const actor = await this.getActor(actorId);
        const item = actor.items?.find((i: any) => i._id === itemId || i.id === itemId);
        if (!item) return false;
        await this.sendMessage(`<b>${actor.name}</b> uses <b>${item.name}</b>`, this.userId || undefined);
        return true;
    }

    // Admin / World Control
    public async launchWorld(worldId: string) { /* ... */ }
    public async shutdownWorld() { /* ... */ }

    public async getSystem(): Promise<any> {
        return this.gameDataCache?.system || {};
    }

    public async getUsers(failHard: boolean = false): Promise<any[]> {
        // Prefer cached users from the initial game data handshake; avoids a round-trip socket call
        if (this.gameDataCache?.users?.length) {
            return this.gameDataCache.users;
        }
        const response: any = await this.dispatchDocumentSocket('User', 'get', { broadcast: false }, undefined, failHard);
        return response?.result || [];
    }

    async evaluate<T>(): Promise<T> {
        return this.gameDataCache as any;
    }

    /**
     * Internal helper to keep userMap and gameDataCache in sync with real-time events.
     */
    private updateUserInCache(userId: string, data: Partial<any>) {
        const existing = this.userMap.get(userId);
        const updated = existing ? { ...existing, ...data } : { _id: userId, ...data };

        // Update User Map
        this.userMap.set(userId, updated);

        // Update gameDataCache for Status Handler
        if (this.gameDataCache && Array.isArray(this.gameDataCache.users)) {
            const index = this.gameDataCache.users.findIndex((u: any) => (u._id === userId || u.id === userId));
            if (index !== -1) {
                this.gameDataCache.users[index] = { ...this.gameDataCache.users[index], ...data };
            } else {
                this.gameDataCache.users.push(updated);
            }
        }

        // If user was unknown but became active, try healing data
        if (!existing && data.active === true && !data.name) {
            this.getUsers().then(dbUsers => {
                const fullUser = dbUsers.find((u: any) => (u._id === userId || u.id === userId));
                if (fullUser) {
                    this.updateUserInCache(userId, fullUser);
                    logger.debug(`CoreSocket | Self-healed user data for ${fullUser.name}`);
                }
            }).catch(() => { });
        }
    }

    public getUser(userId: string): any {
        return this.userMap.get(userId);
    }
}
