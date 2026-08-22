import type { Request, Response } from 'express';

export const PLAYER_SESSION_COOKIE_NAME = 'sheet-delver-session';
export const PLAYER_SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24;

/** Parse one named cookie without adding a global cookie-parser dependency. */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
    if (!cookieHeader) return undefined;

    for (const segment of cookieHeader.split(';')) {
        const separator = segment.indexOf('=');
        if (separator < 0) continue;
        const key = segment.slice(0, separator).trim();
        if (key !== name) continue;

        const rawValue = segment.slice(separator + 1).trim();
        try {
            return decodeURIComponent(rawValue);
        } catch {
            return undefined;
        }
    }
    return undefined;
}

export function readBearerToken(req: Pick<Request, 'headers'>): string | undefined {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) return undefined;
    const token = authorization.slice('Bearer '.length).trim();
    return token || undefined;
}

export function readPlayerSessionCookie(cookieHeader: string | undefined): string | undefined {
    return readCookie(cookieHeader, PLAYER_SESSION_COOKIE_NAME);
}

/** Bearer remains available to trusted server callers; browsers use the cookie. */
export function readRequestSessionCredential(req: Pick<Request, 'headers'>): string | undefined {
    return readBearerToken(req) || readPlayerSessionCookie(req.headers.cookie);
}

export function setPlayerSessionCookie(res: Response, sessionId: string, secure: boolean): void {
    res.cookie(PLAYER_SESSION_COOKIE_NAME, sessionId, {
        httpOnly: true,
        sameSite: 'strict',
        secure,
        path: '/',
        maxAge: PLAYER_SESSION_MAX_AGE_MS,
    });
}

export function clearPlayerSessionCookie(res: Response, secure: boolean): void {
    // Clear with the same scope/security attributes used at creation.
    res.clearCookie(PLAYER_SESSION_COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'strict',
        secure,
        path: '/',
    });
}
