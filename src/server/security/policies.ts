import type { Request, Response, NextFunction } from 'express';
import { logger } from '@shared/utils/logger';
import { getConfig } from '@server/core/config';
import { isAdminClientAddressAllowed } from '@server/security/adminNetwork';

function normalizeAddress(address: string | undefined): string | undefined {
    if (!address) {
        return undefined;
    }

    return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function getForwardedClientAddress(req: Request): string | undefined {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (typeof forwardedFor !== 'string') {
        return undefined;
    }

    const [firstHop] = forwardedFor.split(',');
    return normalizeAddress(firstHop?.trim());
}

/**
 * Enforce the configured client CIDRs. Forwarded addresses are trusted only
 * from the loopback Next.js proxy; direct Core callers use their socket peer.
 */
export function requireAdminNetwork(req: Request, res: Response, next: NextFunction): void {
    const socketAddress = normalizeAddress(req.socket.remoteAddress);
    const socketIsLoopback = socketAddress === '127.0.0.1' || socketAddress === '::1';
    const forwardedClientAddress = socketIsLoopback ? getForwardedClientAddress(req) : undefined;
    const effectiveAddress = forwardedClientAddress || socketAddress;

    if (!isAdminClientAddressAllowed(effectiveAddress, getConfig().security.adminAllowedNetworks)) {
        logger.warn(`Core Service | Blocked Admin API request from disallowed network address ${effectiveAddress}`);
        res.status(403).json({ error: 'Admin access restricted to configured networks' });
        return;
    }
    next();
}

function normalizeOrigin(value: string): string | undefined {
    try {
        return new URL(value).origin;
    } catch {
        return undefined;
    }
}

interface AdminOriginRequestHeaders {
    origin?: string;
    referer?: string;
    fetchSite?: string;
}

/** Pure policy helper kept separate so denial cases do not require server state. */
export function isAdminOriginRequestAllowed(
    headers: AdminOriginRequestHeaders,
    expectedOrigin: string,
): boolean {
    const requestOrigin = headers.origin ? normalizeOrigin(headers.origin) : undefined;
    const fetchSite = headers.fetchSite?.toLowerCase();
    const refererOrigin = headers.referer ? normalizeOrigin(headers.referer) : undefined;

    if (requestOrigin !== undefined) {
        return requestOrigin === expectedOrigin;
    }
    if (fetchSite !== undefined && fetchSite !== 'none') {
        return refererOrigin === expectedOrigin;
    }
    return true;
}

/**
 * Browser requests must arrive through the configured local admin origin.
 * Origin-less callers still pass network and normal admin authentication.
 */
export function requireAdminOrigin(req: Request, res: Response, next: NextFunction): void {
    const expectedOrigin = getConfig().app.adminOrigin;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const referer = typeof req.headers.referer === 'string' ? req.headers.referer : undefined;
    const fetchSite = typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : undefined;

    if (!isAdminOriginRequestAllowed({ origin, referer, fetchSite }, expectedOrigin)) {
        logger.warn(`Core Service | Blocked Admin API request outside configured origin: ${origin || referer || fetchSite}`);
        res.status(403).json({ error: 'Admin access restricted to the configured local origin' });
        return;
    }
    next();
}
