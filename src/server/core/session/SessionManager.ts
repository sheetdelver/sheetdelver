import { ClientSocket } from '../foundry/sockets/ClientSocket';
import { FoundryConfig } from '../foundry/types';
import { logger } from '@shared/utils/logger';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { persistentCache } from '../cache/PersistentCache';
import { systemService } from '../system/SystemService';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { worldLifecycleStore } from '@server/core/world/WorldLifecycleStore';
import type { RestoredFoundrySessionCredential } from '@server/shared/types/foundry';

interface Session {
    id: string;
    client: ClientSocket;
    userId: string;
    username: string;
    lastActive: number;
    worldId?: string;
    cookie?: string;
}

// Persistent cache shape. This stays interpreted here so ClientSocket only
// receives the already validated wire credential it needs to reconnect.
interface CachedSessionRecord {
    username?: string;
    userId?: string;
    cookie?: string;
    worldId?: string;
    lastSaved?: number;
}

type RestoreAttemptResult =
    | { status: 'restored'; client: ClientSocket; userId: string; sessionId: string }
    | { status: 'retryable' }
    | { status: 'terminal' };

export class SessionManager {
    private config: FoundryConfig;
    private sessions: Map<string, Session> = new Map();
    private restorePromises: Map<string, Promise<Session | undefined>> = new Map();
    private readonly SESSION_TIMEOUT_MS = 1000 * 60 * 60 * 24; // 24 Hours
    private readonly CACHE_NS = 'core';
    private readonly CACHE_KEY = 'sessions';
    private isSaving: boolean = false;

    private readonly RESTORE_RETRY_BASE_DELAY_MS = 300;
    private readonly RESTORE_RETRY_MAX_DELAY_MS = 2000;

    constructor(config: FoundryConfig) {
        this.config = config;

        // Listen for world level changes to invalidate sessions
        systemService.on('world:connected', (data) => {
            if (data.state === 'setup') {
                this.clearAllSessions();
            }
        });
    }

    public async initialize() {
        logger.info('SessionManager | Initializing Session storage...');
    }

    public isCacheReady(): boolean {
        return systemService.isReady();
    }

    public async createSession(username: string, password?: string): Promise<{ sessionId: string, userId: string }> {
        logger.info(`SessionManager | Creating session for user: ${username}`);
        // SessionManager owns the app session lifecycle; ClientSocket only
        // performs the user-scoped Foundry transport login/reconnect.

        // Enforce Single Session per User: Cleanup any existing sessions for this user
        for (const [id, session] of this.sessions.entries()) {
            if (session.username === username) {
                logger.info(`SessionManager | Found existing session for ${username} (${id}). Destroying...`);
                await this.destroySession(id);
            }
        }

        const client = new ClientSocket({ ...this.config, username, password });

        try {
            // ClientSocket connects individually to act as an Auth Anchor
            await client.login(username, password);

            const sessionId = crypto ? crypto.randomUUID() : (Math.random().toString(36).substring(2) + Date.now().toString(36));
            const userId = client.userId || 'unknown';

            const session = {
                id: sessionId,
                client,
                userId: userId,
                username,
                lastActive: Date.now(),
                // Bind sessions to the active world via WorldStateStore. This
                // keeps session validation independent from CoreSocket's legacy
                // gameData cache while still invalidating on world switches.
                worldId: worldStateStore.getCurrentWorldId() || undefined,
                cookie: client.getSessionCookie() ?? undefined
            };
            this.sessions.set(sessionId, session);

            await this.saveSession(sessionId, client, username);

            logger.info(`SessionManager | Session created: ${sessionId} (User: ${username}, ID: ${userId})`);
            return { sessionId, userId };

        } catch (error: unknown) {
            logger.error(`SessionManager | Failed to create session: ${getErrorMessage(error)}`);
            client.disconnect();
            throw error;
        }
    }

    public async getOrRestoreSession(sessionId: string): Promise<Session | undefined> {
        const session = this.sessions.get(sessionId);

        // Defer validation if world is not yet active/discovered
        const lifecycleState = worldLifecycleStore.getState();
        if (lifecycleState === 'setup' || lifecycleState === 'offline') {
            if (session) {
                // Return existing session from memory, but avoid world ID checks
                session.lastActive = Date.now();
                return session;
            }
            // If not in memory, let the cache path decide whether the active
            // world is known enough to safely restore this token.
            return this.restoreSessionFromCache(sessionId, 1);
        }

        // Check for active session in memory
        if (session) {
            // Validate world ID only after active-world metadata is available.
            // Setup/offline/startup states can restore sessions optimistically;
            // a mismatch is enforceable once WorldStateStore knows the world id.
            const currentWorldId = worldStateStore.getCurrentWorldId();

            if (!currentWorldId || lifecycleState !== 'active') {
                // No world data available or world still starting up - defer validation
                logger.debug(`SessionManager | World not fully active (${lifecycleState}). Deferring validation for session ${sessionId}.`);
                session.lastActive = Date.now();
                return session;
            }

            if (session.worldId && session.worldId !== currentWorldId) {
                logger.warn(`SessionManager | World mismatch for session ${sessionId}. Expected: ${session.worldId}, Current: ${currentWorldId}. Destroying session.`);
                await this.destroySession(sessionId);
                return undefined;
            }

            session.lastActive = Date.now();
            return session;
        }

        return this.restoreSessionFromCache(sessionId, 3);
    }

    public async destroySession(sessionId: string) {
        const session = this.sessions.get(sessionId);
        if (session) {
            logger.info(`SessionManager | Destroying session: ${sessionId}`);
            await session.client.logout();
            session.client.disconnect();
            this.sessions.delete(sessionId);
            await this.clearSession(sessionId);
        }
    }

    public async clearAllSessions() {
        logger.info('SessionManager | Invalidating all sessions due to world disconnect/setup.');
        for (const sessionId of this.sessions.keys()) {
            await this.destroySession(sessionId);
        }
        this.sessions.clear();
        await persistentCache.delete(this.CACHE_NS, this.CACHE_KEY);
    }

    public isValidSession(sessionId: string): boolean {
        return this.sessions.has(sessionId);
    }

    private restoreSessionFromCache(sessionId: string, maxAttempts: number): Promise<Session | undefined> {
        const existingRestore = this.restorePromises.get(sessionId);
        if (existingRestore) return existingRestore;

        // HTTP status, REST auth middleware, and Socket.IO auth can all ask
        // for the same token during startup. This guard makes them share one
        // restore attempt instead of creating duplicate user presence sockets.
        const restorePromise = this.restoreSessionFromCacheWithRetries(sessionId, maxAttempts)
            .finally(() => {
                this.restorePromises.delete(sessionId);
            });

        this.restorePromises.set(sessionId, restorePromise);
        return restorePromise;
    }

    private async restoreSessionFromCacheWithRetries(sessionId: string, maxAttempts: number): Promise<Session | undefined> {
        for (let i = 0; i < maxAttempts; i++) {
            const restored = await this.tryRestoreSession(sessionId);
            if (restored.status === 'restored' && restored.sessionId === sessionId) {
                return this.sessions.get(sessionId);
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
                logger.info(`SessionManager | Cached session ${sessionId} is expired or incomplete. Purging key.`);
                await this.clearSession(sessionId);
                return { status: 'terminal' };
            }

            const foundryUsername = sessionData.username || sessionId;

            // World/session matching is restore policy, not socket behavior.
            // Only connect a user transport once the cached session is known
            // to belong to the active world.
            let currentWorldId = worldStateStore.getCurrentWorldId();

            const lifecycleState = worldLifecycleStore.getState();
            if (!currentWorldId && (lifecycleState === 'startup' || lifecycleState === 'active')) {
                logger.debug(`SessionManager | World not yet stable. Waiting for ID to restore session ${sessionId}...`);
                for (let i = 0; i < 5; i++) {
                    await this.waitForRestoreBackoff(i);
                    currentWorldId = worldStateStore.getCurrentWorldId();
                    if (currentWorldId) break;
                }
            }

            if (!currentWorldId) {
                logger.debug(`SessionManager | Deferring restoration for ${sessionId} - World ID still unknown. (State: ${lifecycleState})`);
                return { status: 'terminal' };
            }

            if (!sessionData.worldId) {
                logger.warn(`SessionManager | Cached session ${sessionId} has no world id. Purging key before restore.`);
                await this.clearSession(sessionId);
                return { status: 'terminal' };
            }

            if (currentWorldId !== sessionData.worldId) {
                logger.warn(`SessionManager | World mismatch (Current: ${currentWorldId}, Session: ${sessionData.worldId}). Purging key ${sessionId}.`);
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

            this.sessions.set(sessionId, {
                id: sessionId, client, userId: credential.userId,
                username: foundryUsername, lastActive: Date.now(),
                worldId: sessionData.worldId, cookie: credential.cookie
            });

            return { status: 'restored', client, userId: credential.userId, sessionId };

        } catch (error: unknown) {
            logger.error(`SessionManager | Error during session restoration: ${getErrorMessage(error)}`);
            client?.disconnect();
            return { status: 'retryable' };
        }
    }

    private isCachedSessionFresh(sessionData: CachedSessionRecord): boolean {
        if (!sessionData.cookie || !sessionData.userId || typeof sessionData.lastSaved !== 'number') {
            return false;
        }
        return Date.now() - sessionData.lastSaved <= this.SESSION_TIMEOUT_MS;
    }

    private toRestoredCredential(sessionData: CachedSessionRecord): RestoredFoundrySessionCredential | null {
        // The transport only needs a Cookie header and Foundry user id. Cache
        // timestamps, usernames, and world ids remain SessionManager policy.
        if (!sessionData.cookie || !sessionData.userId) return null;
        return {
            cookie: sessionData.cookie,
            userId: sessionData.userId,
        };
    }

    private async saveSession(key: string, client: any, foundryUsername?: string) {
        while (this.isSaving) await new Promise(r => setTimeout(r, 50));
        this.isSaving = true;
        try {
            const sessions = (await this.loadSessions()) || {};

            sessions[key] = {
                username: foundryUsername || key,
                userId: client.userId,
                cookie: client.getSessionCookie() ?? undefined,
                worldId: worldStateStore.getCurrentWorldId() || undefined,
                lastSaved: Date.now()
            };

            await persistentCache.set(this.CACHE_NS, this.CACHE_KEY, sessions);
            logger.info(`SessionManager | Saved session for ${foundryUsername || key} (Key: ${key}) to disk. Total: ${Object.keys(sessions).length}`);
        } catch (e) {
            logger.warn(`SessionManager | Failed to save session: ${e}`);
        } finally {
            this.isSaving = false;
        }
    }

    private async loadSessions(): Promise<Record<string, CachedSessionRecord> | null> {
        try {
            return await persistentCache.get<Record<string, CachedSessionRecord>>(this.CACHE_NS, this.CACHE_KEY) || {};
        } catch (e) {
            logger.error(`SessionManager | CRITICAL: Failed to load sessions: ${e}`);
            return null; // Signals failure, do not overwrite
        }
    }

    private async clearSession(key: string) {
        while (this.isSaving) await new Promise(r => setTimeout(r, 50));
        this.isSaving = true;
        try {
            const sessions = await this.loadSessions();
            if (sessions && sessions[key]) {
                delete sessions[key];
                await persistentCache.set(this.CACHE_NS, this.CACHE_KEY, sessions);
                logger.info(`SessionManager | Cleared key ${key} from disk.`);
            }
        } finally {
            this.isSaving = false;
        }
    }

    private async waitForRestoreBackoff(attempt: number) {
        const delay = Math.min(
            this.RESTORE_RETRY_BASE_DELAY_MS * (2 ** attempt),
            this.RESTORE_RETRY_MAX_DELAY_MS
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
    }
}
