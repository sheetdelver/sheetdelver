import { randomBytes } from 'node:crypto';
import { logger } from '@shared/utils/logger';
import type { AdminSessionClaims } from './types/admin-auth.types';

const SERVER_INSTANCE_ID = randomBytes(16).toString('hex');

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

/** In-memory, revocable admin sessions keyed by opaque random credentials. */
class AdminSessionManager {
    private sessions: Map<string, AdminSessionClaims> = new Map();
    private cleanupInterval: NodeJS.Timeout | null = null;

    /**
     * Initialize the session manager with periodic cleanup of expired sessions.
     */
    public initialize(): void {
        if (this.cleanupInterval) return;
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
        } while (this.sessions.has(tokenStr));
        this.sessions.set(tokenStr, claims);
        return tokenStr;
    }

    /**
     * Retrieve and validate a session by token string.
     * Returns null if invalid, expired, or not found.
     */
    public getSession(tokenStr: string): AdminSessionClaims | null {
        const claims = this.sessions.get(tokenStr);
        if (!claims) return null;
        if (!isSessionValid(claims)) {
            this.sessions.delete(tokenStr);
            return null;
        }
        return claims;
    }

    /**
     * Invalidate (revoke) a session.
     */
    public revokeSession(tokenStr: string): void {
        this.sessions.delete(tokenStr);
    }

    /**
     * Revoke all sessions for a given admin.
     * Used during password reset.
     */
    public revokeAllForAdmin(adminId: string): void {
        for (const [tokenStr, claims] of this.sessions.entries()) {
            if (claims.adminId === adminId) {
                this.sessions.delete(tokenStr);
            }
        }
        logger.info(`Revoked all sessions for admin ${adminId}`);
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
