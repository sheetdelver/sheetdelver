import type { Request, Response, NextFunction } from 'express';
import { logger } from '@shared/utils/logger';

function isBrowserOriginRequest(req: Request): boolean {
    return typeof req.headers.origin === 'string' || typeof req.headers['sec-fetch-site'] === 'string';
}

/**
 * Enforce CSRF protection for browser-origin admin mutation requests.
 * Non-browser callers (CLI/service automation) are not subject to CSRF checks.
 */
export function requireAdminCsrf(req: Request, res: Response, next: NextFunction): void {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase())) {
        next();
        return;
    }

    if (!isBrowserOriginRequest(req)) {
        next();
        return;
    }

    const csrfHeader = req.headers['x-admin-csrf-token'];
    const providedToken = typeof csrfHeader === 'string' ? csrfHeader.trim() : '';
    const expectedToken = req.adminSession?.csrfToken;

    if (!providedToken || !expectedToken || providedToken !== expectedToken) {
        logger.warn(`Admin CSRF validation failed for ${req.method} ${req.path} from ${req.ip}`);
        res.status(403).json({
            error: 'Forbidden',
            reason: 'Missing or invalid admin CSRF token',
        });
        return;
    }

    next();
}
