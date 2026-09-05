import type { Request, Response } from 'express';
import { readBearerToken, readCookie } from './playerSessionCookie';
import { getConfig } from '@server/core/config';

export const ADMIN_SESSION_COOKIE_NAME = 'sheet-delver-admin-session';
export const ADMIN_SESSION_COOKIE_PATH = '/api/admin';
export const ADMIN_SESSION_MAX_AGE_MS = 15 * 60 * 1000;

export function readAdminSessionCookie(cookieHeader: string | undefined): string | undefined {
    return readCookie(cookieHeader, ADMIN_SESSION_COOKIE_NAME);
}

/**
 * Explicit bearer credentials remain available to loopback CLI tools. Browser
 * requests authenticate through the path-scoped HttpOnly cookie.
 */
export function readAdminSessionCredential(req: Pick<Request, 'headers'>): string | undefined {
    return readBearerToken(req)
        || readAdminSessionCookie(req.headers.cookie);
}

function configuredSecureTransport(): boolean {
    return new URL(getConfig().app.adminOrigin).protocol === 'https:';
}

export function setAdminSessionCookie(
    res: Response,
    sessionId: string,
    secure = configuredSecureTransport(),
): void {
    res.cookie(ADMIN_SESSION_COOKIE_NAME, sessionId, {
        httpOnly: true,
        sameSite: 'strict',
        secure,
        path: ADMIN_SESSION_COOKIE_PATH,
        maxAge: ADMIN_SESSION_MAX_AGE_MS,
    });
}

export function clearAdminSessionCookie(res: Response, secure = configuredSecureTransport()): void {
    // Clear with the exact path/security attributes used at issuance.
    res.clearCookie(ADMIN_SESSION_COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'strict',
        secure,
        path: ADMIN_SESSION_COOKIE_PATH,
    });
}
