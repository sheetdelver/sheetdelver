import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { logger } from '@shared/utils/logger';
import { getSecurityDir, writeOwnerOnlyFileAtomicSync } from '@server/core/paths';
import type { AdminSessionClaims } from './types/admin-auth.types';

const SERVER_INSTANCE_ID = randomBytes(16).toString('hex');
export const ADMIN_RESTART_HANDOFF_LIFETIME_MS = 2 * 60 * 1000;

interface AdminRestartHandoff {
    version: 1;
    createdAt: number;
    expiresAt: number;
    sessions: Array<{
        tokenDigest: string;
        claims: AdminSessionClaims;
    }>;
}

function getRestartHandoffPath(): string {
    return path.join(getSecurityDir(), 'admin-restart-handoff.json');
}

function digestSessionToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('base64url');
}

function removeRestartHandoffFile(filePath: string): void {
    try {
        fs.unlinkSync(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

function isRestartHandoffClaims(value: unknown): value is AdminSessionClaims {
    if (!value || typeof value !== 'object') return false;
    const claims = value as Partial<AdminSessionClaims>;
    return claims.principalType === 'app-admin'
        && typeof claims.adminId === 'string'
        && Number.isInteger(claims.issuedAt)
        && Number.isInteger(claims.expiresAt)
        && typeof claims.csrfToken === 'string'
        && typeof claims.instanceId === 'string';
}

/** Create server-only claims for one short-lived admin session. */
export function createAdminSessionClaims(adminId: string, durationMs: number): AdminSessionClaims {
    const now = Date.now();
    return {
        principalType: 'app-admin',
        adminId,
        issuedAt: now,
        expiresAt: now + durationMs,
        csrfToken: randomBytes(24).toString('base64url'),
        instanceId: SERVER_INSTANCE_ID,
    };
}

/**
 * Check if a session claims object is still valid.
 */
export function isSessionValid(claims: AdminSessionClaims): boolean {
    return claims.principalType === 'app-admin'
        && claims.expiresAt > Date.now()
        && claims.instanceId === SERVER_INSTANCE_ID;
}

/**
 * Get remaining lifetime in milliseconds.
 * Returns 0 if expired.
 */
export function getSessionRemainingMs(claims: AdminSessionClaims): number {
    const remaining = claims.expiresAt - Date.now();
    return remaining > 0 ? remaining : 0;
}

/** In-memory, revocable admin sessions keyed by opaque-credential digests. */
export class AdminSessionManager {
    private sessions: Map<string, AdminSessionClaims> = new Map();
    private cleanupInterval: NodeJS.Timeout | null = null;

    /**
     * Initialize the session manager with periodic cleanup of expired sessions.
     */
    public initialize(): void {
        if (this.cleanupInterval) return;
        try {
            this.restoreSupervisedRestartHandoff();
        } catch (error) {
            logger.warn('Admin auth: discarded invalid supervised-restart handoff', error);
        }
        // Clean up expired sessions every 5 minutes
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [tokenStr, claims] of this.sessions.entries()) {
                if (claims.expiresAt <= now) {
                    this.sessions.delete(tokenStr);
                }
            }
        }, 5 * 60 * 1000);
    }

    /**
     * Store server-only claims and return an opaque credential. Claims and CSRF
     * state never become part of the browser credential itself.
     */
    public storeSession(claims: AdminSessionClaims): string {
        let tokenStr: string;
        do {
            tokenStr = randomBytes(32).toString('base64url');
        } while (this.sessions.has(digestSessionToken(tokenStr)));
        this.sessions.set(digestSessionToken(tokenStr), claims);
        return tokenStr;
    }

    /**
     * Retrieve and validate a session by token string.
     * Returns null if invalid, expired, or not found.
     */
    public getSession(tokenStr: string): AdminSessionClaims | null {
        const tokenDigest = digestSessionToken(tokenStr);
        const claims = this.sessions.get(tokenDigest);
        if (!claims) return null;
        if (!isSessionValid(claims)) {
            this.sessions.delete(tokenDigest);
            return null;
        }
        return claims;
    }

    /**
     * Invalidate (revoke) a session.
     */
    public revokeSession(tokenStr: string): void {
        this.sessions.delete(digestSessionToken(tokenStr));
    }

    /**
     * Revoke all sessions for a given admin.
     * Used during password reset.
     */
    public revokeAllForAdmin(adminId: string): void {
        for (const [tokenDigest, claims] of this.sessions.entries()) {
            if (claims.adminId === adminId) {
                this.sessions.delete(tokenDigest);
            }
        }
        logger.info(`Revoked all sessions for admin ${adminId}`);
    }

    /**
     * Persist valid sessions for one supervised Core replacement. The browser's
     * opaque credential is never written to disk; only its one-way digest is
     * handed to the next process. A cold restart has no handoff and therefore
     * retains the process-bound session policy.
     */
    public prepareSupervisedRestartHandoff(
        filePath = getRestartHandoffPath(),
        now = Date.now(),
    ): number {
        const sessions = Array.from(this.sessions.entries())
            .filter(([, claims]) => isSessionValid(claims))
            .map(([tokenDigest, claims]) => ({ tokenDigest, claims }));

        if (sessions.length === 0) {
            removeRestartHandoffFile(filePath);
            return 0;
        }

        const handoff: AdminRestartHandoff = {
            version: 1,
            createdAt: now,
            expiresAt: now + ADMIN_RESTART_HANDOFF_LIFETIME_MS,
            sessions,
        };
        writeOwnerOnlyFileAtomicSync(filePath, JSON.stringify(handoff));
        return sessions.length;
    }

    /** Consume the short-lived restart handoff, rebinding claims to this process. */
    public restoreSupervisedRestartHandoff(
        filePath = getRestartHandoffPath(),
        now = Date.now(),
    ): number {
        if (!fs.existsSync(filePath)) return 0;

        let parsed: unknown;
        try {
            const stat = fs.lstatSync(filePath);
            if (stat.isSymbolicLink() || !stat.isFile()) {
                throw new Error('restart handoff path is not a regular file');
            }
            parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } finally {
            // The handoff is single-use even when malformed. A later cold start
            // must never retry stale restart authority.
            removeRestartHandoffFile(filePath);
        }

        if (!parsed || typeof parsed !== 'object') return 0;
        const handoff = parsed as Partial<AdminRestartHandoff>;
        if (handoff.version !== 1
            || !Number.isInteger(handoff.createdAt)
            || !Number.isInteger(handoff.expiresAt)
            || handoff.createdAt! > now
            || handoff.expiresAt! !== handoff.createdAt! + ADMIN_RESTART_HANDOFF_LIFETIME_MS
            || handoff.expiresAt! <= now
            || !Array.isArray(handoff.sessions)) {
            return 0;
        }

        let restored = 0;
        for (const entry of handoff.sessions) {
            if (!entry || typeof entry.tokenDigest !== 'string'
                || !/^[A-Za-z0-9_-]{43}$/.test(entry.tokenDigest)
                || !isRestartHandoffClaims(entry.claims)
                || entry.claims.expiresAt <= now) {
                continue;
            }
            this.sessions.set(entry.tokenDigest, {
                ...entry.claims,
                instanceId: SERVER_INSTANCE_ID,
            });
            restored += 1;
        }

        if (restored > 0) {
            logger.info(`Admin auth: restored ${restored} session(s) after supervised restart`);
        }
        return restored;
    }

    /**
     * Shutdown: clear cleanup interval.
     */
    public shutdown(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
}

export const adminSessionManager = new AdminSessionManager();
