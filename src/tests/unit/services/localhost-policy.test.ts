import { strict as assert } from 'node:assert';
import type { NextFunction, Request, Response } from 'express';
import { requireLocalhost } from '@server/security/policies';

type ResponseStub = {
    statusCode: number;
    payload: unknown;
    status: (code: number) => Response;
    json: (body: unknown) => Response;
};

function createResponseStub(): ResponseStub {
    const state: ResponseStub = {
        statusCode: 200,
        payload: undefined,
        status(code: number) {
            state.statusCode = code;
            return state as unknown as Response;
        },
        json(body: unknown) {
            state.payload = body;
            return state as unknown as Response;
        },
    };

    return state;
}

function runPolicyTests() {
    const runCase = (remoteAddress: string | undefined, forwardedFor?: string) => {
        const req = {
            socket: { remoteAddress },
            headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
        } as Request;
        const res = createResponseStub();

        let nextCalled = false;
        const next: NextFunction = () => {
            nextCalled = true;
        };

        requireLocalhost(req, res as unknown as Response, next);
        return { nextCalled, statusCode: res.statusCode, payload: res.payload };
    };

    const loopbackV4 = runCase('127.0.0.1');
    assert.equal(loopbackV4.nextCalled, true);
    assert.equal(loopbackV4.statusCode, 200);

    const loopbackV6 = runCase('::1');
    assert.equal(loopbackV6.nextCalled, true);
    assert.equal(loopbackV6.statusCode, 200);

    const loopbackMapped = runCase('::ffff:127.0.0.1');
    assert.equal(loopbackMapped.nextCalled, true);
    assert.equal(loopbackMapped.statusCode, 200);

    const proxiedLocal = runCase('127.0.0.1', '127.0.0.1');
    assert.equal(proxiedLocal.nextCalled, true);
    assert.equal(proxiedLocal.statusCode, 200);

    const proxiedRemote = runCase('127.0.0.1', '10.0.0.42');
    assert.equal(proxiedRemote.nextCalled, false);
    assert.equal(proxiedRemote.statusCode, 403);

    const blocked = runCase('10.0.0.42');
    assert.equal(blocked.nextCalled, false);
    assert.equal(blocked.statusCode, 403);
    assert.deepEqual(blocked.payload, { error: 'Admin access restricted to localhost' });
}

export function run() {
    runPolicyTests();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('localhost-policy.test.ts passed');
}
