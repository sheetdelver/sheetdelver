import { randomUUID } from 'node:crypto';
import { ClientSocket } from '@server/core/foundry/sockets/ClientSocket';
import type { FoundryConfig } from '@server/core/foundry/types';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { worldLifecycleStore } from '@server/core/world/WorldLifecycleStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { FoundryUserRole } from '@server/core/documents/primary/base/ownership';
import { logger } from '@shared/utils/logger';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import type {
    FoundrySessionInvalidationEvent,
    FoundrySessionInvalidationListener,
    FoundrySessionInvalidationReason,
    RestoredFoundrySessionCredential,
} from '@server/shared/types/foundry';
import { foundryEventIngress } from '@server/services/world/FoundryEventIngress';
import { FoundryUserIdentityResolver } from './FoundryUserIdentityResolver';
import { FoundryUserDiscoveryProbe } from './FoundryUserDiscoveryProbe';
import {
    createFoundrySessionStoreFromEnvironment,
    type FoundrySessionStore,
    type PersistedFoundrySessionRecord,
} from '@server/security/foundrySessionStore';

export interface FoundryUserConnection {
    id: string;
    client: ClientSocket;
    userId: string;
    username: string;
    lastActive: number;
    worldId?: string;
    cookie?: string;
    authorizationRole: FoundryUserRole;
    detachFoundryEventIngress?: () => void;
}

type RestoreAttemptResult =
    | { status: 'restored'; client: ClientSocket; userId: string; connectionId: string }
    | { status: 'retryable' }
    | { status: 'terminal' };

export class FoundryUserConnectionService {
    private readonly config: FoundryConfig;
    private readonly connections = new Map<string, FoundryUserConnection>();
    private readonly restorePromises = new Map<string, Promise<FoundryUserConnection | undefined>>();
    private readonly authorizationRefreshPromises = new Map<string, Promise<void>>();
    private readonly SESSION_TIMEOUT_MS = 1000 * 60 * 60 * 24;
    private readonly RESTORE_RETRY_BASE_DELAY_MS = 300;
    private readonly RESTORE_RETRY_MAX_DELAY_MS = 2000;
    private authorityEpoch = 0;
    private readonly sessionAuthorityVersions = new Map<string, number>();
    private readonly deletedUserIds = new Set<string>();
    private isSaving = false;
    private cacheReadyProbe: () => boolean = () => true;
    private readonly sessionStore: FoundrySessionStore;
    private readonly sessionInvalidationListeners = new Set<FoundrySessionInvalidationListener>();

    public constructor(config: FoundryConfig, options: { sessionStore?: FoundrySessionStore } = {}) {
        this.config = config;
        this.sessionStore = options.sessionStore ?? createFoundrySessionStoreFromEnvironment();
    }

    public async initialize(): Promise<void> {
        logger.info('FoundryUserConnectionService | Initializing connection storage...');
        await this.sessionStore.initialize();
    }

    public setSystemReadinessProbe(probe: () => boolean): void {
        this.cacheReadyProbe = probe;
    }

    /** Subscribe app-socket authority to server-side session retirement. */
    public onSessionInvalidated(listener: FoundrySessionInvalidationListener): () => void {
        this.sessionInvalidationListeners.add(listener);
        return () => this.sessionInvalidationListeners.delete(listener);
    }

    // Foundry sessions are world-bound; setup means the prior world's live and
    // persisted credentials must be invalidated before another world launches.
    public handleWorldEnteredSetup(): Promise<void> {
        return this.clearAllSessions('world-entered-setup');
    }

    public isCacheReady(): boolean {
        return this.cacheReadyProbe();
    }

    public async createSession(username: string, password?: string): Promise<{ sessionId: string; userId: string }> {
        logger.info(`FoundryUserConnectionService | Creating Foundry user connection for: ${username}`);
        const authorityEpoch = this.authorityEpoch;

        for (const [id, connection] of this.connections.entries()) {
            if (connection.username === username) {
                logger.info(`FoundryUserConnectionService | Found existing connection for ${username} (${id}). Destroying...`);
                await this.destroySession(id, 'replaced');
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
            if (this.deletedUserIds.has(userId)) {
                throw new Error(`Cannot create a session for deleted Foundry user ${userId}`);
            }

            // Capture before transport connection so a concurrent role change
            // is detected once the new session is registered below.
            const authorizationRole = userStore.getRole(userId);
            client.userId = userId;
            await client.login(username, password);
            if (authorityEpoch !== this.authorityEpoch || this.deletedUserIds.has(userId)) {
                throw new Error('World session authority changed while login was in progress');
            }
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
                authorizationRole,
                detachFoundryEventIngress,
            };
            this.connections.set(sessionId, connection);

            await this.saveSession(sessionId, client, username);
            if (authorityEpoch !== this.authorityEpoch || !this.connections.has(sessionId)) {
                // A setup transition can retire authority while the protected
                // session write is queued; never report that login as valid.
                throw new Error('World session authority changed while login was being persisted');
            }

            await this.refreshSessionAuthorization(sessionId);
            if (!this.connections.has(sessionId)) {
                throw new Error('Foundry authorization refresh retired the new session');
            }

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

        // Setup/closed have no active world against which a world-bound session
        // can be validated. The setup transition owns cache invalidation.
        if (lifecycleState === 'setup' || lifecycleState === 'closed') {
            return undefined;
        }

        // Offline/startup can be transient. Preserve live sessions, but do not
        // create a cached transport until the active world identity is known.
        if (lifecycleState === 'offline' || lifecycleState === 'startup') {
            if (connection) {
                connection.lastActive = Date.now();
                return connection;
            }
            logger.debug(`FoundryUserConnectionService | Deferring restore for ${sessionId} (lifecycle=${lifecycleState}); caller is status-only until ready.`);
            return undefined;
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
                await this.destroySession(sessionId, 'world-mismatch');
                return undefined;
            }

            connection.lastActive = Date.now();
            return connection;
        }

        return this.restoreSessionFromCache(sessionId, 3);
    }

    public async destroySession(
        sessionId: string,
        reason: FoundrySessionInvalidationReason = 'revoked',
    ): Promise<void> {
        const connection = this.retireSessionAuthority(sessionId, reason);
        if (connection) await this.destroyLiveConnection(connection);
        // Logout must also purge a protected record when this process has not
        // restored its ClientSocket yet; otherwise the cleared browser cookie
        // leaves a reusable server-side credential behind.
        await this.clearSession(sessionId);
    }

    /** Retire every live or persisted session bound to one deleted Foundry user. */
    public async destroySessionsForUser(userId: string): Promise<void> {
        if (!userId) return;

        // The tombstone closes login/restore races while encrypted records are
        // located and removed. Foundry User ids are not reused within a world.
        this.deletedUserIds.add(userId);
        const sessionIds = new Set<string>();
        for (const connection of this.connections.values()) {
            if (connection.userId === userId) sessionIds.add(connection.id);
        }

        const persisted = await this.loadSessions();
        for (const [sessionId, record] of Object.entries(persisted ?? {})) {
            if (record.userId === userId) sessionIds.add(sessionId);
        }

        const liveConnections: FoundryUserConnection[] = [];
        for (const sessionId of sessionIds) {
            const connection = this.retireSessionAuthority(sessionId, 'user-deleted');
            if (connection) liveConnections.push(connection);
        }

        // Protected credentials are removed before best-effort Foundry logout
        // so a failed or slow upstream transport cannot preserve app authority.
        for (const sessionId of sessionIds) await this.clearSession(sessionId);
        for (const connection of liveConnections) await this.destroyLiveConnection(connection);

        logger.info(`FoundryUserConnectionService | Retired ${sessionIds.size} session(s) for deleted Foundry user ${userId}.`);
    }

    /**
     * Rebind live Foundry sockets when their User role changes. Foundry binds
     * authorization to the socket's User object, so retaining that socket can
     * preserve either stale denial after elevation or stale authority after a
     * downgrade. Disconnecting first makes mutations fail closed while the
     * existing Foundry session is rebound.
     */
    public async refreshSessionsForUserAuthorization(userId: string): Promise<void> {
        if (!userId) return;
        const sessionIds = Array.from(this.connections.values())
            .filter(connection => connection.userId === userId)
            .map(connection => connection.id);
        await Promise.all(sessionIds.map(sessionId => this.refreshSessionAuthorization(sessionId)));
    }

    private async refreshSessionAuthorization(sessionId: string): Promise<void> {
        const pending = this.authorizationRefreshPromises.get(sessionId);
        if (pending) {
            await pending;
            return this.refreshSessionAuthorization(sessionId);
        }

        const connection = this.connections.get(sessionId);
        if (!connection) return;
        const nextRole = userStore.getRole(connection.userId);
        if (connection.authorizationRole === nextRole) return;

        const refresh = this.rebindSessionAuthorization(connection, nextRole);
        this.authorizationRefreshPromises.set(sessionId, refresh);
        try {
            await refresh;
        } finally {
            if (this.authorizationRefreshPromises.get(sessionId) === refresh) {
                this.authorizationRefreshPromises.delete(sessionId);
            }
        }

        // Coalesce rapid role updates without allowing an intermediate role to
        // remain bound after the first reconnect finishes.
        const current = this.connections.get(sessionId);
        if (current && current.authorizationRole !== userStore.getRole(current.userId)) {
            await this.refreshSessionAuthorization(sessionId);
        }
    }

    private async rebindSessionAuthorization(
        connection: FoundryUserConnection,
        nextRole: FoundryUserRole,
    ): Promise<void> {
        const sessionId = connection.id;
        const credential: RestoredFoundrySessionCredential | null = connection.client.userId
            ? {
                userId: connection.client.userId,
                cookie: connection.client.getSessionCookie() || connection.cookie || '',
            }
            : null;
        if (!credential?.cookie) {
            await this.destroySession(sessionId, 'revoked');
            throw new Error(`Cannot refresh Foundry authorization for ${connection.username}: session credential is unavailable`);
        }

        const authorityEpoch = this.authorityEpoch;
        logger.info(
            `FoundryUserConnectionService | Refreshing Foundry authorization for ${connection.username} `
            + `(role ${connection.authorizationRole} -> ${nextRole}).`,
        );

        // This synchronous disconnect closes the stale-authority window before
        // any asynchronous handshake or status refresh can run.
        connection.client.disconnect();
        try {
            await connection.client.connectWithRestoredCredential(credential);
            if (
                authorityEpoch !== this.authorityEpoch
                || this.connections.get(sessionId) !== connection
            ) {
                connection.client.disconnect();
                return;
            }

            connection.authorizationRole = nextRole;
            connection.cookie = connection.client.getSessionCookie() ?? credential.cookie;
            connection.lastActive = Date.now();
            await this.saveSession(sessionId, connection.client, connection.username);
            logger.info(`FoundryUserConnectionService | Refreshed Foundry authorization for ${connection.username}.`);
        } catch (error: unknown) {
            if (this.connections.get(sessionId) === connection) {
                await this.destroySession(sessionId, 'revoked');
            }
            throw error;
        }
    }

    private async destroyLiveConnection(connection: FoundryUserConnection): Promise<void> {
        logger.info(`FoundryUserConnectionService | Destroying connection: ${connection.id}`);
        this.detachConnectionIngress(connection);
        try {
            await connection.client.logout();
        } catch (error: unknown) {
            // Server authority is still retired if Foundry's best-effort
            // remote logout fails; retaining it would defeat local revocation.
            logger.warn(`FoundryUserConnectionService | Foundry logout failed during local session teardown: ${getErrorMessage(error)}`);
        }
        try {
            connection.client.disconnect();
        } catch (error: unknown) {
            logger.warn(`FoundryUserConnectionService | Client disconnect failed during local session teardown: ${getErrorMessage(error)}`);
        }
    }

    private detachConnectionIngress(connection: FoundryUserConnection): void {
        const detach = connection.detachFoundryEventIngress;
        connection.detachFoundryEventIngress = undefined;
        try {
            detach?.();
        } catch (error: unknown) {
            logger.warn(`FoundryUserConnectionService | Ingress detach failed during local session teardown: ${getErrorMessage(error)}`);
        }
    }

    public async clearAllSessions(
        reason: FoundrySessionInvalidationReason = 'revoked',
    ): Promise<void> {
        logger.info('FoundryUserConnectionService | Invalidating all Foundry user connections due to world disconnect/setup.');
        const connections = Array.from(this.connections.values());
        // Retire authority before waiting on remote logout. The epoch prevents
        // any in-flight login or restore from repopulating the cleared map.
        this.authorityEpoch += 1;
        this.deletedUserIds.clear();
        this.connections.clear();
        for (const connection of connections) this.detachConnectionIngress(connection);
        this.emitSessionInvalidated({ scope: 'all', reason });
        try {
            // Remove restorable credentials before best-effort remote logouts;
            // the latter may be slow or unavailable during a world transition.
            await this.clearSessionStore();
        } finally {
            for (const connection of connections) {
                await this.destroyLiveConnection(connection);
            }
        }
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
                this.sessionAuthorityVersions.delete(sessionId);
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
        const authorityEpoch = this.authorityEpoch;
        const sessionAuthorityVersion = this.getSessionAuthorityVersion(sessionId);
        try {
            const cached = await this.loadSessions();
            if (!cached) return { status: 'retryable' };

            const sessionData = cached[sessionId];
            if (!sessionData) return { status: 'terminal' };

            const invalidReason = this.getCachedSessionInvalidationReason(sessionData);
            if (invalidReason) {
                logger.info(`FoundryUserConnectionService | Cached session ${sessionId} is expired or incomplete. Purging key.`);
                await this.invalidatePersistedSession(sessionId, invalidReason);
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
                await this.invalidatePersistedSession(sessionId, 'invalid-record');
                return { status: 'terminal' };
            }

            if (currentWorldId !== sessionData.worldId) {
                logger.warn(`FoundryUserConnectionService | World mismatch (Current: ${currentWorldId}, Session: ${sessionData.worldId}). Purging key ${sessionId}.`);
                await this.invalidatePersistedSession(sessionId, 'world-mismatch');
                return { status: 'terminal' };
            }

            const credential = this.toRestoredCredential(sessionData);
            if (!credential) return { status: 'terminal' };
            if (this.deletedUserIds.has(credential.userId)) {
                await this.invalidatePersistedSession(sessionId, 'user-deleted');
                return { status: 'terminal' };
            }

            client = new ClientSocket({
                ...this.config,
                username: foundryUsername,
            });

            // Reconcile after registration if a role update overlaps transport
            // restoration and therefore could not target this connection yet.
            const authorizationRole = userStore.getRole(credential.userId);
            await client.connectWithRestoredCredential(credential);
            if (
                authorityEpoch !== this.authorityEpoch
                || sessionAuthorityVersion !== this.getSessionAuthorityVersion(sessionId)
                || this.deletedUserIds.has(credential.userId)
            ) {
                // Revocation won while transport connection was in flight.
                client.disconnect();
                return { status: 'terminal' };
            }
            const detachFoundryEventIngress = foundryEventIngress.attach(client);

            this.connections.set(sessionId, {
                id: sessionId,
                client,
                userId: credential.userId,
                username: foundryUsername,
                lastActive: Date.now(),
                worldId: sessionData.worldId,
                cookie: credential.cookie,
                authorizationRole,
                detachFoundryEventIngress,
            });

            await this.refreshSessionAuthorization(sessionId);
            if (!this.connections.has(sessionId)) return { status: 'terminal' };

            return { status: 'restored', client, userId: credential.userId, connectionId: sessionId };
        } catch (error: unknown) {
            logger.error(`FoundryUserConnectionService | Error during session restoration: ${getErrorMessage(error)}`);
            client?.disconnect();
            return { status: 'retryable' };
        }
    }

    private getCachedSessionInvalidationReason(
        sessionData: PersistedFoundrySessionRecord,
    ): 'expired' | 'invalid-record' | null {
        if (!sessionData.cookie || !sessionData.userId || typeof sessionData.lastSaved !== 'number') {
            return 'invalid-record';
        }
        return Date.now() - sessionData.lastSaved > this.SESSION_TIMEOUT_MS
            ? 'expired'
            : null;
    }

    private toRestoredCredential(sessionData: PersistedFoundrySessionRecord): RestoredFoundrySessionCredential | null {
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

            await this.sessionStore.save(sessions);
            if (this.sessionStore.enabled) {
                logger.info(`FoundryUserConnectionService | Saved protected session for ${foundryUsername || key} (Key: ${key}). Total: ${Object.keys(sessions).length}`);
            }
        } catch (e) {
            logger.warn(`FoundryUserConnectionService | Failed to save session: ${e}`);
        } finally {
            this.isSaving = false;
        }
    }

    private async loadSessions(): Promise<Record<string, PersistedFoundrySessionRecord> | null> {
        try {
            return await this.sessionStore.load();
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
                await this.sessionStore.save(sessions);
                if (this.sessionStore.enabled) {
                    logger.info(`FoundryUserConnectionService | Cleared protected session key ${key}.`);
                }
            }
        } finally {
            this.isSaving = false;
        }
    }

    private async clearSessionStore(): Promise<void> {
        while (this.isSaving) await new Promise(r => setTimeout(r, 50));
        this.isSaving = true;
        try {
            // Serialize a world-wide purge with per-session saves so a late
            // save cannot recreate credentials from the retired world.
            await this.sessionStore.clear();
        } finally {
            this.isSaving = false;
        }
    }

    private async invalidatePersistedSession(
        sessionId: string,
        reason: FoundrySessionInvalidationReason,
    ): Promise<void> {
        this.retireSessionAuthority(sessionId, reason);
        await this.clearSession(sessionId);
    }

    private getSessionAuthorityVersion(sessionId: string): number {
        return this.sessionAuthorityVersions.get(sessionId) ?? 0;
    }

    private retireSessionAuthority(
        sessionId: string,
        reason: FoundrySessionInvalidationReason,
    ): FoundryUserConnection | undefined {
        const connection = this.connections.get(sessionId);
        this.connections.delete(sessionId);
        // A per-session version is needed only while restore is in flight;
        // avoiding permanent entries keeps arbitrary invalid token churn bounded.
        if (this.restorePromises.has(sessionId)) {
            this.sessionAuthorityVersions.set(
                sessionId,
                this.getSessionAuthorityVersion(sessionId) + 1,
            );
        }
        // Notify after the map removal but before remote/storage cleanup so
        // app sockets lose authority immediately and reconciliation sees false.
        this.emitSessionInvalidated({ scope: 'session', sessionId, reason });
        return connection;
    }

    private emitSessionInvalidated(event: FoundrySessionInvalidationEvent): void {
        for (const listener of this.sessionInvalidationListeners) {
            try {
                listener(event);
            } catch (error: unknown) {
                // One faulty subscriber cannot prevent other sockets from
                // dropping authority after the service has retired a session.
                logger.error(`FoundryUserConnectionService | Session invalidation listener failed: ${getErrorMessage(error)}`);
            }
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
