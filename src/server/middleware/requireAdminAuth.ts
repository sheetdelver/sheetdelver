import type { Request, Response, NextFunction } from 'express';
import { logger } from '@shared/utils/logger';
import { adminSessionManager, parseAndValidateToken } from '@server/security/adminSessionService';
import { appendAdminAuditEvent } from '@server/security/adminAuditLog';
import type { AdminSessionClaims } from '@server/security/types/admin-auth.types';
import { ManagerOutcome } from '@shared/types/modules';

// Module augmentation for Express Request to include admin session claims
declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            adminSession?: AdminSessionClaims;
            /** Raw admin session token as presented, retained so routes (e.g. logout) can revoke it. */
            adminSessionToken?: string;
        }
    }
}

/**
 * Middleware that requires a valid admin session token.
 * Explicitly rejects Foundry sessions and service tokens.
 * Enforces principal type separation.
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
    try {
        // Extract token from Authorization header (Bearer scheme) or from custom header
        const authHeader = req.headers.authorization || req.headers['x-admin-token'];
        if (!authHeader) {
            logger.debug('Admin auth required but no token provided');
            res.status(401).json({
                error: 'Admin authentication required',
                reason: 'No authentication token provided',
            });
            return;
        }

        let token: string | undefined;

        // Handle "Bearer <token>" format
        if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
            token = authHeader.slice(7).trim();
        } else if (typeof authHeader === 'string') {
            // Direct token
            token = authHeader.trim();
        }

        if (!token) {
            logger.debug('Admin auth: empty token after parsing');
            res.status(401).json({
                error: 'Admin authentication required',
                reason: 'Invalid token format',
            });
            return;
        }

        // Reject if this looks like a Foundry session or service token
        // Foundry sessions are typically UUID or hex strings
        // Service tokens are usually base64-ish or opaque strings not matching our session format
        // Try to parse as JSON to distinguish admin tokens from others
        let claims: AdminSessionClaims | null = null;
        try {
            claims = parseAndValidateToken(token);
        } catch (parseError) {
            logger.debug('Failed to parse token as admin session', parseError);
        }

        if (!claims) {
            // Token is either invalid, expired, or not an admin session
            // Try to distinguish between service/Foundry tokens vs our own expired tokens
            let isOurTokenFormat = false;
            let hasWrongPrincipalType = false;
            try {
                const parsed = JSON.parse(token);
                // If it parses as JSON and has our expected structure: it's our token format
                if (typeof parsed === 'object' && 'principalType' in parsed) {
                    isOurTokenFormat = true;
                    // Check if it's wrong principal type specifically
                    if (parsed.principalType !== 'app-admin') {
                        hasWrongPrincipalType = true;
                    }
                }
            } catch {
                // Not JSON; could be UUID or opaque service token
                isOurTokenFormat = false;
            }

            // If it's our token format but wrong principal type, return 403 (not authenticated as admin)
            if (hasWrongPrincipalType) {
                logger.warn(
                    `Admin route: rejected token with wrong principal type from ${req.ip}`
                );
                res.status(403).json({
                    error: 'Forbidden',
                    reason: 'Only app-admin principal type is allowed for admin operations',
                });
                return;
            }

            if (!isOurTokenFormat) {
                // Check if it might be a Foundry or service token attempting bypass
                // Service tokens are typically not JSON, and Foundry sessions are UUIDs or hex strings
                const isJwtLike = (token.match(/\./g) || []).length === 2; // JWT format: xxx.yyy.zzz
                const isUuidLike = token.includes('-') && token.match(/^[0-9a-f-]+$/i); // UUID-like
                if (isJwtLike || isUuidLike || token.length > 100) {
                    logger.warn(`Admin route: rejected non-admin credential (likely Foundry/service token) from ${req.ip}`);
                    res.status(403).json({
                        error: 'Forbidden',
                        reason: 'Service tokens and Foundry sessions cannot be used for admin operations',
                    });
                    return;
                }
            }

            // It's our token format but invalid or expired
            logger.debug('Admin auth: invalid or expired token');
            res.status(401).json({
                error: 'Admin authentication failed',
                reason: 'Token invalid or expired',
            });
            return;
        }

        // Additional validation: verify principal type
        if (claims.principalType !== 'app-admin') {
            logger.warn(
                `Admin route: rejected token with wrong principal type "${claims.principalType}" from ${req.ip}`
            );
            res.status(403).json({
                error: 'Forbidden',
                reason: 'Only app-admin principal type is allowed for admin operations',
            });
            return;
        }

        // Session-store presence check: a structurally valid token must still
        // correspond to an active (non-revoked) session. This is what makes
        // revokeSession/revokeAllForAdmin authoritative — password reset and
        // logout immediately stop the affected tokens from authenticating
        // (ADR-0029 Phase 1). Stateless parsing alone is not sufficient.
        const activeSession = adminSessionManager.getSession(token);
        if (!activeSession) {
            logger.debug('Admin auth: token structurally valid but session revoked or unknown');
            res.status(401).json({
                error: 'Admin authentication failed',
                reason: 'Session has been revoked or is no longer active',
            });
            return;
        }

        // Attach claims to request for downstream handlers
        req.adminSession = activeSession;
        req.adminSessionToken = token;
        logger.debug(`Admin auth: authenticated as ${activeSession.adminId}`);
        next();
    } catch (error) {
        logger.error('Admin auth middleware error', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}

/**
 * Optional middleware to log all admin actions for audit purposes.
 */
export function auditAdminAction(req: Request, res: Response, next: NextFunction): void {
    if (req.adminSession) {
        const startedAt = Date.now();
        const adminId = req.adminSession.adminId;
        const method = req.method;
        const requestPath = req.path;
        const ip = req.ip || 'unknown';
        const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;

        res.once('finish', () => {
            const statusCode = res.statusCode;
            const outcome = statusCode < 400 ? ManagerOutcome.Success : ManagerOutcome.Failure;
            const durationMs = Date.now() - startedAt;

            void appendAdminAuditEvent({
                adminId,
                method,
                path: requestPath,
                statusCode,
                outcome,
                ip,
                userAgent,
                durationMs,
            });
        });
    }
    next();
}
