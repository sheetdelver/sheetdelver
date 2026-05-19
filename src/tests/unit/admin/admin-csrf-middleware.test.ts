import { strict as assert } from 'node:assert';
import type { Request, Response, NextFunction } from 'express';
import { requireAdminCsrf } from '@server/middleware/requireAdminCsrf';

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

function createRequestStub(options?: {
    method?: string;
    origin?: string;
    csrfHeader?: string;
    expectedCsrf?: string;
}): Request {
    const headers: Record<string, string> = {};
    if (options?.origin) {
        headers.origin = options.origin;
    }
    if (options?.csrfHeader) {
        headers['x-admin-csrf-token'] = options.csrfHeader;
    }

    return {
        method: options?.method || 'POST',
        headers,
        ip: '127.0.0.1',
        path: '/admin/world/launch',
        adminSession: options?.expectedCsrf ? ({ csrfToken: options.expectedCsrf } as any) : undefined,
    } as Request;
}

async function runAdminCsrfMiddlewareTests(): Promise<void> {
    console.log('Running admin CSRF middleware tests...');

    // Test 1: Non-browser request bypasses CSRF check
    console.log('  Test 1: Non-browser request bypasses CSRF check');
    const req1 = createRequestStub({ method: 'POST' });
    const res1 = createResponseStub();
    let nextCalled1 = false;
    const next1: NextFunction = () => {
        nextCalled1 = true;
    };

    requireAdminCsrf(req1, res1 as unknown as Response, next1);
    assert.equal(nextCalled1, true, 'Non-browser request should pass');

    // Test 2: Browser request with matching token passes
    console.log('  Test 2: Browser request with matching token passes');
    const csrfToken = 'abc123def456ghi789';
    const req2 = createRequestStub({
        method: 'POST',
        origin: 'http://localhost:3000',
        csrfHeader: csrfToken,
        expectedCsrf: csrfToken,
    });
    const res2 = createResponseStub();
    let nextCalled2 = false;
    const next2: NextFunction = () => {
        nextCalled2 = true;
    };

    requireAdminCsrf(req2, res2 as unknown as Response, next2);
    assert.equal(nextCalled2, true, 'Browser request with valid CSRF should pass');

    // Test 3: Browser request missing token fails
    console.log('  Test 3: Browser request missing token fails');
    const req3 = createRequestStub({
        method: 'POST',
        origin: 'http://localhost:3000',
        expectedCsrf: 'expected-token',
    });
    const res3 = createResponseStub();
    let nextCalled3 = false;
    const next3: NextFunction = () => {
        nextCalled3 = true;
    };

    requireAdminCsrf(req3, res3 as unknown as Response, next3);
    assert.equal(nextCalled3, false, 'Missing CSRF token should fail');
    assert.equal(res3.statusCode, 403, 'Missing CSRF token should return 403');

    // Test 4: Browser request with mismatched token fails
    console.log('  Test 4: Browser request with mismatched token fails');
    const req4 = createRequestStub({
        method: 'POST',
        origin: 'http://localhost:3000',
        csrfHeader: 'wrong-token',
        expectedCsrf: 'correct-token',
    });
    const res4 = createResponseStub();
    let nextCalled4 = false;
    const next4: NextFunction = () => {
        nextCalled4 = true;
    };

    requireAdminCsrf(req4, res4 as unknown as Response, next4);
    assert.equal(nextCalled4, false, 'Mismatched CSRF token should fail');
    assert.equal(res4.statusCode, 403, 'Mismatched CSRF token should return 403');

    // Test 5: Safe methods are not CSRF-enforced
    console.log('  Test 5: Safe methods bypass CSRF check');
    const req5 = createRequestStub({ method: 'GET', origin: 'http://localhost:3000' });
    const res5 = createResponseStub();
    let nextCalled5 = false;
    const next5: NextFunction = () => {
        nextCalled5 = true;
    };

    requireAdminCsrf(req5, res5 as unknown as Response, next5);
    assert.equal(nextCalled5, true, 'GET should bypass CSRF middleware');

    console.log('  All admin CSRF middleware tests passed!');
}

export function run(): Promise<void> {
    return runAdminCsrfMiddlewareTests();
}
