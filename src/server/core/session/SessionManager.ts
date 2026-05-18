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

interface Session {
    id: string;
    client: ClientSocket;
    userId: string;
    username: string;
    lastActive: number;
    worldId?: string;
    cookie?: string;
}

export class SessionManager {
    private config: FoundryConfig;
    private sessions: Map<string, Session> = new Map();
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
        // Note: We don't implement login inside ClientSocket yet, waiting on user to verify separation.
        // For now, ClientSocket expects a resumed session or guest interaction.
        // IF we need explicit login, we should add a login() method to ClientSocket similar to CoreSocket.
        // Assuming we need to replicate the SocketClient "login" behavior here for now.

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
            // If not in memory, try to restore from disk without strict world verification
            return this.tryRestoreSession(sessionId).then(restored => 
                restored ? this.sessions.get(sessionId) : undefined
            );
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

        // Try to restore from disk with minor retries (for transient startup/world discovery issues)
        for (let i = 0; i < 3; i++) {
            const restored = await this.tryRestoreSession(sessionId);
            if (restored && restored.sessionId === sessionId) {
                return this.sessions.get(sessionId);
            }
            if (i < 2) {
                await this.waitForRestoreBackoff(i);
            }
        }

        return undefined;
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

    public async tryRestoreSession(username: string): Promise<{ client: ClientSocket, userId: string, sessionId: string } | null> {
        try {
            const cached = await this.loadSessions();
            if (!cached) return null;

            const sessionData = cached[username];
            if (!sessionData) return null;

            if (!sessionData.cookie || !sessionData.userId) {
                return null;
            }

            const foundryUsername = sessionData.username || username;

            // Check World State via System Provider
            let currentWorldId = worldStateStore.getCurrentWorldId();

            const lifecycleState = worldLifecycleStore.getState();
            if (!currentWorldId && (lifecycleState === 'startup' || lifecycleState === 'active')) {
                logger.debug(`SessionManager | World not yet stable. Waiting for ID to restore session ${username}...`);
                for (let i = 0; i < 5; i++) {
                    await this.waitForRestoreBackoff(i);
                    currentWorldId = worldStateStore.getCurrentWorldId();
                    if (currentWorldId) break;
                }
            }

            // Strict Validation: ONLY purge if we are 100% sure we have an ACTUAL mismatch
            if (currentWorldId && sessionData.worldId && currentWorldId !== sessionData.worldId) {
                logger.warn(`SessionManager | World mismatch (Current: ${currentWorldId}, Session: ${sessionData.worldId}). Purging key ${username}.`);
                await this.clearSession(username);
                return null;
            }

            if (!currentWorldId) {
                logger.debug(`SessionManager | Deferring restoration for ${username} - World ID still unknown. (State: ${lifecycleState})`);
                return null; 
            }

            const client = new ClientSocket({
                ...this.config,
                username: foundryUsername,
            });

            await client.restoreSession(sessionData.cookie, sessionData.userId);

            const sessionId = username;
            this.sessions.set(sessionId, {
                id: sessionId, client, userId: sessionData.userId,
                username: foundryUsername, lastActive: Date.now(),
                worldId: sessionData.worldId, cookie: sessionData.cookie
            });

            return { client, userId: sessionData.userId, sessionId };

        } catch (e) {
            logger.error(`SessionManager | Error during session restoration: ${e}`);
            return null;
        }
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

    private async loadSessions(): Promise<Record<string, any> | null> {
        try {
            return await persistentCache.get<Record<string, any>>(this.CACHE_NS, this.CACHE_KEY) || {};
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
