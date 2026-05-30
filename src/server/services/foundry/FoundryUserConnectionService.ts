import { randomUUID } from 'node:crypto';
import { ClientSocket } from '@server/core/foundry/sockets/ClientSocket';
import type { FoundryConfig } from '@server/core/foundry/types';
import { persistentCache } from '@server/core/cache/PersistentCache';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { worldLifecycleStore } from '@server/core/world/WorldLifecycleStore';
import { logger } from '@shared/utils/logger';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import type { RestoredFoundrySessionCredential } from '@server/shared/types/foundry';
import { foundryEventIngress } from '@server/services/world/FoundryEventIngress';
import { FoundryUserIdentityResolver } from './FoundryUserIdentityResolver';
import { FoundryUserDiscoveryProbe } from './FoundryUserDiscoveryProbe';

export interface FoundryUserConnection {
    id: string;
    client: ClientSocket;
    userId: string;
    username: string;
    lastActive: number;
    worldId?: string;
    cookie?: string;
    detachFoundryEventIngress?: () => void;
}

interface CachedFoundryConnectionRecord {
    username?: string;
    userId?: string;
    cookie?: string;
    worldId?: string;
    lastSaved?: number;
}

type RestoreAttemptResult =
    | { status: 'restored'; client: ClientSocket; userId: string; connectionId: string }
    | { status: 'retryable' }
    | { status: 'terminal' };

export class FoundryUserConnectionService {
    private readonly config: FoundryConfig;
    private readonly connections = new Map<string, FoundryUserConnection>();
    private readonly restorePromises = new Map<string, Promise<FoundryUserConnection | undefined>>();
    private readonly SESSION_TIMEOUT_MS = 1000 * 60 * 60 * 24;
    private readonly CACHE_NS = 'core';
    private readonly CACHE_KEY = 'sessions';
    private readonly RESTORE_RETRY_BASE_DELAY_MS = 300;
    private readonly RESTORE_RETRY_MAX_DELAY_MS = 2000;
    private isSaving = false;
    private cacheReadyProbe: () => boolean = () => true;

    public constructor(config: FoundryConfig) {
        this.config = config;
    }

    public async initialize(): Promise<void> {
        logger.info('FoundryUserConnectionService | Initializing connection storage...');
    }

    public setSystemReadinessProbe(probe: () => boolean): void {
        this.cacheReadyProbe = probe;
    }

    public handleWorldEnteredSetup(): void {
        void this.clearAllSessions();
    }

    public isCacheReady(): boolean {
        return this.cacheReadyProbe();
    }

    public async createSession(username: string, password?: string): Promise<{ sessionId: string; userId: string }> {
        logger.info(`FoundryUserConnectionService | Creating Foundry user connection for: ${username}`);

        for (const [id, connection] of this.connections.entries()) {
            if (connection.username === username) {
                logger.info(`FoundryUserConnectionService | Found existing connection for ${username} (${id}). Destroying...`);
                await this.destroySession(id);
            }
        }

        const client = new ClientSocket({ ...this.config, username, password });

        try {
            const discoveryProbe = new FoundryUserDiscoveryProbe(this.config);
            const resolver = new FoundryUserIdentityResolver({
                getUsers: () => discoveryProbe.discoverUsers(),
            });
            const userId = await resolver.resolveUserId(username);
            if (!userId) {
                throw new Error(`Could not identify user ID for ${username}`);
            }

            client.userId = userId;
            await client.login(username, password);
            const detachFoundryEventIngress = foundryEventIngress.attach(client);

            const sessionId = randomUUID();
            const connection = {
                id: sessionId,
                client,
                userId,
                username,
                lastActive: Date.now(),
                worldId: worldStateStore.getCurrentWorldId() || undefined,
                cookie: client.getSessionCookie() ?? undefined,
                detachFoundryEventIngress,
            };
            this.connections.set(sessionId, connection);

            await this.saveSession(sessionId, client, username);

            logger.info(`FoundryUserConnectionService | Connection created: ${sessionId} (User: ${username}, ID: ${userId})`);
            return { sessionId, userId };
        } catch (error: unknown) {
            logger.error(`FoundryUserConnectionService | Failed to create connection: ${getErrorMessage(error)}`);
            client.disconnect();
            throw error;
        }
    }

    public async getOrRestoreSession(sessionId: string): Promise<FoundryUserConnection | undefined> {
        const connection = this.connections.get(sessionId);
        const lifecycleState = worldLifecycleStore.getState();

        if (lifecycleState === 'setup' || lifecycleState === 'offline' || lifecycleState === 'startup') {
            if (connection) {
                connection.lastActive = Date.now();
                return connection;
            }
            if (lifecycleState === 'startup') {
                logger.debug(`FoundryUserConnectionService | Deferring restore for ${sessionId} (lifecycle=startup); caller is status-only until ready.`);
                return undefined;
            }
            return this.restoreSessionFromCache(sessionId, 1);
        }

        if (connection) {
            const currentWorldId = worldStateStore.getCurrentWorldId();

            if (!currentWorldId || lifecycleState !== 'active') {
                logger.debug(`FoundryUserConnectionService | World not fully active (${lifecycleState}). Deferring validation for session ${sessionId}.`);
                connection.lastActive = Date.now();
                return connection;
            }

            if (connection.worldId && connection.worldId !== currentWorldId) {
                logger.warn(`FoundryUserConnectionService | World mismatch for session ${sessionId}. Expected: ${connection.worldId}, Current: ${currentWorldId}. Destroying session.`);
                await this.destroySession(sessionId);
                return undefined;
            }

            connection.lastActive = Date.now();
            return connection;
        }

        return this.restoreSessionFromCache(sessionId, 3);
    }

    public async destroySession(sessionId: string): Promise<void> {
        const connection = this.connections.get(sessionId);
        if (connection) {
            logger.info(`FoundryUserConnectionService | Destroying connection: ${sessionId}`);
            connection.detachFoundryEventIngress?.();
            await connection.client.logout();
            connection.client.disconnect();
            this.connections.delete(sessionId);
            await this.clearSession(sessionId);
        }
    }

    public async clearAllSessions(): Promise<void> {
        logger.info('FoundryUserConnectionService | Invalidating all Foundry user connections due to world disconnect/setup.');
        for (const sessionId of this.connections.keys()) {
            await this.destroySession(sessionId);
        }
        this.connections.clear();
        await persistentCache.delete(this.CACHE_NS, this.CACHE_KEY);
    }

    public isValidSession(sessionId: string): boolean {
        return this.connections.has(sessionId);
    }

    private restoreSessionFromCache(sessionId: string, maxAttempts: number): Promise<FoundryUserConnection | undefined> {
        const existingRestore = this.restorePromises.get(sessionId);
        if (existingRestore) return existingRestore;

        const restorePromise = this.restoreSessionFromCacheWithRetries(sessionId, maxAttempts)
            .finally(() => {
                this.restorePromises.delete(sessionId);
            });

        this.restorePromises.set(sessionId, restorePromise);
        return restorePromise;
    }

    private async restoreSessionFromCacheWithRetries(sessionId: string, maxAttempts: number): Promise<FoundryUserConnection | undefined> {
        for (let i = 0; i < maxAttempts; i++) {
            const restored = await this.tryRestoreSession(sessionId);
            if (restored.status === 'restored' && restored.connectionId === sessionId) {
                return this.connections.get(sessionId);
            }
            if (restored.status === 'terminal') return undefined;

            if (i < maxAttempts - 1) {
                await this.waitForRestoreBackoff(i);
            }
        }

        return undefined;
    }

    private async tryRestoreSession(sessionId: string): Promise<RestoreAttemptResult> {
        let client: ClientSocket | null = null;
        try {
            const cached = await this.loadSessions();
            if (!cached) return { status: 'retryable' };

            const sessionData = cached[sessionId];
            if (!sessionData) return { status: 'terminal' };

            if (!this.isCachedSessionFresh(sessionData)) {
                logger.info(`FoundryUserConnectionService | Cached session ${sessionId} is expired or incomplete. Purging key.`);
                await this.clearSession(sessionId);
                return { status: 'terminal' };
            }

            const foundryUsername = sessionData.username || sessionId;
            let currentWorldId = worldStateStore.getCurrentWorldId();

            const lifecycleState = worldLifecycleStore.getState();
            if (!currentWorldId && (lifecycleState === 'startup' || lifecycleState === 'active')) {
                logger.debug(`FoundryUserConnectionService | World not yet stable. Waiting for ID to restore session ${sessionId}...`);
                for (let i = 0; i < 5; i++) {
                    await this.waitForRestoreBackoff(i);
                    currentWorldId = worldStateStore.getCurrentWorldId();
                    if (currentWorldId) break;
                }
            }

            if (!currentWorldId) {
                logger.debug(`FoundryUserConnectionService | Deferring restoration for ${sessionId} - World ID still unknown. (State: ${lifecycleState})`);
                return { status: 'terminal' };
            }

            if (!sessionData.worldId) {
                logger.warn(`FoundryUserConnectionService | Cached session ${sessionId} has no world id. Purging key before restore.`);
                await this.clearSession(sessionId);
                return { status: 'terminal' };
            }

            if (currentWorldId !== sessionData.worldId) {
                logger.warn(`FoundryUserConnectionService | World mismatch (Current: ${currentWorldId}, Session: ${sessionData.worldId}). Purging key ${sessionId}.`);
                await this.clearSession(sessionId);
                return { status: 'terminal' };
            }

            const credential = this.toRestoredCredential(sessionData);
            if (!credential) return { status: 'terminal' };

            client = new ClientSocket({
                ...this.config,
                username: foundryUsername,
            });

            await client.connectWithRestoredCredential(credential);
            const detachFoundryEventIngress = foundryEventIngress.attach(client);

            this.connections.set(sessionId, {
                id: sessionId,
                client,
                userId: credential.userId,
                username: foundryUsername,
                lastActive: Date.now(),
                worldId: sessionData.worldId,
                cookie: credential.cookie,
                detachFoundryEventIngress,
            });

            return { status: 'restored', client, userId: credential.userId, connectionId: sessionId };
        } catch (error: unknown) {
            logger.error(`FoundryUserConnectionService | Error during session restoration: ${getErrorMessage(error)}`);
            client?.disconnect();
            return { status: 'retryable' };
        }
    }

    private isCachedSessionFresh(sessionData: CachedFoundryConnectionRecord): boolean {
        if (!sessionData.cookie || !sessionData.userId || typeof sessionData.lastSaved !== 'number') {
            return false;
        }
        return Date.now() - sessionData.lastSaved <= this.SESSION_TIMEOUT_MS;
    }

    private toRestoredCredential(sessionData: CachedFoundryConnectionRecord): RestoredFoundrySessionCredential | null {
        if (!sessionData.cookie || !sessionData.userId) return null;
        return {
            cookie: sessionData.cookie,
            userId: sessionData.userId,
        };
    }

    private async saveSession(key: string, client: ClientSocket, foundryUsername?: string): Promise<void> {
        while (this.isSaving) await new Promise(r => setTimeout(r, 50));
        this.isSaving = true;
        try {
            const sessions = (await this.loadSessions()) || {};

            sessions[key] = {
                username: foundryUsername || key,
                userId: client.userId || undefined,
                cookie: client.getSessionCookie() ?? undefined,
                worldId: worldStateStore.getCurrentWorldId() || undefined,
                lastSaved: Date.now(),
            };

            await persistentCache.set(this.CACHE_NS, this.CACHE_KEY, sessions);
            logger.info(`FoundryUserConnectionService | Saved session for ${foundryUsername || key} (Key: ${key}) to disk. Total: ${Object.keys(sessions).length}`);
        } catch (e) {
            logger.warn(`FoundryUserConnectionService | Failed to save session: ${e}`);
        } finally {
            this.isSaving = false;
        }
    }

    private async loadSessions(): Promise<Record<string, CachedFoundryConnectionRecord> | null> {
        try {
            return await persistentCache.get<Record<string, CachedFoundryConnectionRecord>>(this.CACHE_NS, this.CACHE_KEY) || {};
        } catch (e) {
            logger.error(`FoundryUserConnectionService | CRITICAL: Failed to load sessions: ${e}`);
            return null;
        }
    }

    private async clearSession(key: string): Promise<void> {
        while (this.isSaving) await new Promise(r => setTimeout(r, 50));
        this.isSaving = true;
        try {
            const sessions = await this.loadSessions();
            if (sessions && sessions[key]) {
                delete sessions[key];
                await persistentCache.set(this.CACHE_NS, this.CACHE_KEY, sessions);
                logger.info(`FoundryUserConnectionService | Cleared key ${key} from disk.`);
            }
        } finally {
            this.isSaving = false;
        }
    }

    private async waitForRestoreBackoff(attempt: number): Promise<void> {
        const delay = Math.min(
            this.RESTORE_RETRY_BASE_DELAY_MS * (2 ** attempt),
            this.RESTORE_RETRY_MAX_DELAY_MS,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
    }
}
