import { randomBytes } from 'node:crypto';
import { logger } from '@shared/utils/logger';
import type { AdminSessionClaims } from './types/admin-auth.types';

const SERVER_INSTANCE_ID = randomBytes(16).toString('hex');

/**
 * Create a JWT-like admin session token claims object.
 * In a real deployment, this would be signed. For now, we store in memory/session.
 * This is the contract that other slices will validate.
 */
export function createAdminSessionClaims(adminId: string, durationMs: number): AdminSessionClaims {
    const now = Date.now();
    return {
        principalType: 'app-admin',
        adminId,
        issuedAt: now,
        expiresAt: now + durationMs,
        csrfToken: randomBytes(24).toString('hex'),
        instanceId: SERVER_INSTANCE_ID,
    };
}

/**
 * Check if a session claims object is still valid.
 */
export function isSessionValid(claims: AdminSessionClaims): boolean {
    return claims.expiresAt > Date.now() && claims.instanceId === SERVER_INSTANCE_ID;
}

/**
 * Get remaining lifetime in milliseconds.
 * Returns 0 if expired.
 */
export function getSessionRemainingMs(claims: AdminSessionClaims): number {
    const remaining = claims.expiresAt - Date.now();
    return remaining > 0 ? remaining : 0;
}

/**
 * In a real implementation, tokens would be signed and verified cryptographically.
 * For now, we return claims as a serializable token and verify on re-parse.
 * Slice 4 will add CSRF and hardening.
 */
export function serializeSessionClaims(claims: AdminSessionClaims): string {
    return JSON.stringify(claims);
}

/**
 * Parse and validate a serialized admin session token.
 * Returns null if invalid or expired.
 */
export function parseAndValidateToken(token: string): AdminSessionClaims | null {
    try {
        const claims = JSON.parse(token) as AdminSessionClaims;
        if (!claims.principalType || claims.principalType !== 'app-admin') {
            return null;
        }
        if (!claims.adminId || !Number.isInteger(claims.issuedAt) || !Number.isInteger(claims.expiresAt)) {
            return null;
        }
        if (claims.csrfToken !== undefined && (typeof claims.csrfToken !== 'string' || claims.csrfToken.length < 16)) {
            return null;
        }
        if (claims.instanceId !== SERVER_INSTANCE_ID) {
            logger.debug(`[AdminAuth] Token instance ID mismatch. Token: ${claims.instanceId}, Server: ${SERVER_INSTANCE_ID}`);
            return null;
        }
        if (!isSessionValid(claims)) {
            return null;
        }
        return claims;
    } catch (error) {
        logger.debug('Failed to parse admin session token', error);
        return null;
    }
}

/**
 * Manage active admin sessions in memory.
 * In production, sessions would be persisted to Redis/database with automatic cleanup.
 */
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
     * Store a session token and return the serialized token.
     */
    public storeSession(claims: AdminSessionClaims): string {
        const tokenStr = serializeSessionClaims(claims);
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
