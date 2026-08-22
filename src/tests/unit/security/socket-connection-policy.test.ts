import { strict as assert } from 'node:assert';
import {
    createSocketConnectionLimiter,
    resolveSocketClientAddress,
    SOCKET_TRANSPORT_LIMITS,
} from '@server/security/socketConnectionPolicy';

interface TestSocket {
    conn: { remoteAddress: string };
    handshake: {
        address: string;
        headers: Record<string, string>;
    };
}

function socket(peer: string, forwarded?: string): TestSocket {
    return {
        conn: { remoteAddress: peer },
        handshake: {
            address: peer,
            headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
        },
    };
}

export function run() {
    assert.equal(SOCKET_TRANSPORT_LIMITS.maxHttpBufferSize, 256 * 1024);
    assert.equal(SOCKET_TRANSPORT_LIMITS.perMessageDeflate, false);

    assert.equal(resolveSocketClientAddress(socket('127.0.0.1', '10.0.0.8, 127.0.0.1')), '10.0.0.8');
    assert.equal(resolveSocketClientAddress(socket('::ffff:127.0.0.1', '10.0.0.9')), '10.0.0.9');
    // A direct remote peer cannot spoof another limiter bucket with X-Forwarded-For.
    assert.equal(resolveSocketClientAddress(socket('203.0.113.4', '10.0.0.10')), '203.0.113.4');

    let clock = 0;
    const limiter = createSocketConnectionLimiter({
        windowMs: 1_000,
        maxAttempts: 2,
        now: () => clock,
    });
    const attempt = (candidate: TestSocket): Error | undefined => {
        let result: Error | undefined;
        limiter(candidate as any, (error?: Error) => {
            result = error;
        });
        return result;
    };

    const first = socket('127.0.0.1', '10.0.0.1');
    assert.equal(attempt(first), undefined);
    assert.equal(attempt(first), undefined);
    const rejected = attempt(first) as Error & { data?: { code?: string } };
    assert.equal(rejected?.data?.code, 'socket-rate-limited');

    // Buckets are isolated by effective client address.
    assert.equal(attempt(socket('127.0.0.1', '10.0.0.2')), undefined);

    clock = 1_001;
    assert.equal(attempt(first), undefined);
}
