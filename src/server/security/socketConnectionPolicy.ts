import type { Socket } from 'socket.io';
import { logger } from '@shared/utils/logger';

export const SOCKET_TRANSPORT_LIMITS = {
    maxHttpBufferSize: 256 * 1024,
    connectTimeout: 10_000,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    perMessageDeflate: false,
} as const;

export const SOCKET_CONNECTION_RATE_LIMIT = {
    windowMs: 60_000,
    maxAttempts: 30,
} as const;

interface SocketAddressLike {
    handshake?: {
        address?: string;
        headers?: Record<string, string | string[] | undefined>;
    };
    conn?: { remoteAddress?: string };
}

interface ConnectionWindow {
    startedAt: number;
    attempts: number;
}

function normalizeAddress(address: string | undefined): string | undefined {
    if (!address) return undefined;
    return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function readForwardedAddress(value: string | string[] | undefined): string | undefined {
    const header = Array.isArray(value) ? value[0] : value;
    return normalizeAddress(header?.split(',')[0]?.trim());
}

/** Trust forwarding only from the loopback shell proxy, matching Admin HTTP policy. */
export function resolveSocketClientAddress(socket: SocketAddressLike): string {
    const peer = normalizeAddress(socket.conn?.remoteAddress || socket.handshake?.address);
    const peerIsLoopback = peer === '127.0.0.1' || peer === '::1';
    const forwarded = peerIsLoopback
        ? readForwardedAddress(socket.handshake?.headers?.['x-forwarded-for'])
        : undefined;
    return forwarded || peer || 'unknown';
}

interface SocketConnectionLimiterOptions {
    windowMs?: number;
    maxAttempts?: number;
    now?: () => number;
}

/**
 * Bound Socket.IO handshakes per effective client address. The limiter is
 * intentionally transport-only and does not alter guest/authenticated rooms.
 */
export function createSocketConnectionLimiter(options: SocketConnectionLimiterOptions = {}) {
    const windowMs = options.windowMs ?? SOCKET_CONNECTION_RATE_LIMIT.windowMs;
    const maxAttempts = options.maxAttempts ?? SOCKET_CONNECTION_RATE_LIMIT.maxAttempts;
    const now = options.now ?? Date.now;
    const windows = new Map<string, ConnectionWindow>();
    let evaluations = 0;

    return (socket: Socket, next: (error?: Error) => void): void => {
        const timestamp = now();
        const address = resolveSocketClientAddress(socket);
        const current = windows.get(address);
        const active = current && timestamp - current.startedAt < windowMs
            ? current
            : { startedAt: timestamp, attempts: 0 };
        active.attempts += 1;
        windows.set(address, active);

        // Periodic expiration keeps the process-local map bounded without a timer.
        evaluations += 1;
        if (evaluations % 100 === 0) {
            for (const [key, entry] of windows) {
                if (timestamp - entry.startedAt >= windowMs) windows.delete(key);
            }
        }

        if (active.attempts > maxAttempts) {
            logger.warn(`App Socket | Connection rate limit exceeded for ${address}`);
            const error = new Error('Too many socket connection attempts');
            (error as Error & { data?: unknown }).data = { code: 'socket-rate-limited' };
            next(error);
            return;
        }
        next();
    };
}
