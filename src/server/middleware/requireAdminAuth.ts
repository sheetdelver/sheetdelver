import type { Request, Response, NextFunction } from 'express';
import { logger } from '@shared/utils/logger';
import { adminSessionManager } from '@server/security/adminSessionService';
import { readAdminSessionCredential } from '@server/security/adminSessionCookie';
import { appendAdminAuditEvent } from '@server/security/adminAuditLog';
import type { AdminSessionClaims } from '@server/security/types/admin-auth.types';
import { ManagerOutcome } from '@shared/types/modules';

// Module augmentation for Express Request to include admin session claims
declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            adminSession?: AdminSessionClaims;
            /** Opaque admin session credential retained so logout can revoke it. */
            adminSessionToken?: string;
        }
    }
}

/**
 * Middleware that requires a valid opaque admin session.
 * Unknown Foundry/service credentials remain ordinary unknown sessions; only a
 * server-issued lookup key can resolve to an app-admin principal.
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
    try {
        const token = readAdminSessionCredential(req);
        if (!token) {
            logger.debug('Admin auth required but no session credential was provided');
            res.status(401).json({
                error: 'Admin authentication required',
                reason: 'No active admin session provided',
            });
            return;
        }

        // The credential has no parseable claims. Store presence is the only
        // authentication authority and preserves immediate logout/reset revocation.
        const activeSession = adminSessionManager.getSession(token);
        if (!activeSession) {
            logger.debug('Admin auth: opaque session expired, revoked, or unknown');
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
