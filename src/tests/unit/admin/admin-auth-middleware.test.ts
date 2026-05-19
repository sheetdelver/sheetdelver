import { strict as assert } from 'node:assert';
import type { Request, Response, NextFunction } from 'express';
import { requireAdminAuth } from '@server/middleware/requireAdminAuth';
import { adminSessionManager, createAdminSessionClaims, serializeSessionClaims } from '@server/security/adminSessionService';

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

function createRequestStub(authHeader?: string): Request {
    return {
        headers: authHeader ? { authorization: authHeader } : {},
        ip: '127.0.0.1',
    } as Request;
}

async function runAdminAuthMiddlewareTests(): Promise<void> {
    console.log('Running admin auth middleware tests...');

    adminSessionManager.initialize();

    // Test 1: Valid admin token accepted
    console.log('  Test 1: Valid admin token accepted');
    const adminClaims = createAdminSessionClaims('test-admin', 15 * 60 * 1000);
    const adminToken = adminSessionManager.storeSession(adminClaims);
    const req1 = createRequestStub(`Bearer ${adminToken}`);
    const res1 = createResponseStub();
    let nextCalled1 = false;
    const next1: NextFunction = () => {
        nextCalled1 = true;
    };

    requireAdminAuth(req1, res1 as unknown as Response, next1);
    assert.equal(nextCalled1, true, 'Valid admin token should call next()');
    assert.equal(req1.adminSession?.adminId, 'test-admin', 'Admin session should be attached');

    // Test 2: Missing token rejected
    console.log('  Test 2: Missing token rejected');
    const req2 = createRequestStub();
    const res2 = createResponseStub();
    let nextCalled2 = false;
    const next2: NextFunction = () => {
        nextCalled2 = true;
    };

    requireAdminAuth(req2, res2 as unknown as Response, next2);
    assert.equal(nextCalled2, false, 'No token should not call next()');
    assert.equal(res2.statusCode, 401, 'Should return 401 for missing token');

    // Test 3: Expired token rejected
    console.log('  Test 3: Expired token rejected');
    const expiredClaims = {
        principalType: 'app-admin' as const,
        adminId: 'expired-admin',
        issuedAt: Date.now() - 2000,
        expiresAt: Date.now() - 1000, // Expired
    };
    const expiredToken = serializeSessionClaims(expiredClaims);
    const req3 = createRequestStub(`Bearer ${expiredToken}`);
    const res3 = createResponseStub();
    let nextCalled3 = false;
    const next3: NextFunction = () => {
        nextCalled3 = true;
    };

    requireAdminAuth(req3, res3 as unknown as Response, next3);
    assert.equal(nextCalled3, false, 'Expired token should not call next()');
    assert.equal(res3.statusCode, 401, 'Should return 401 for expired token');

    // Test 4: Foundry session token (UUID-like) explicitly rejected
    console.log('  Test 4: Foundry session token explicitly rejected');
    const foundryToken = 'a1b2c3d4-e5f6-4789-a123-b456c789d012'; // UUID format
    const req4 = createRequestStub(`Bearer ${foundryToken}`);
    const res4 = createResponseStub();
    let nextCalled4 = false;
    const next4: NextFunction = () => {
        nextCalled4 = true;
    };

    requireAdminAuth(req4, res4 as unknown as Response, next4);
    assert.equal(nextCalled4, false, 'Foundry token should not call next()');
    assert.equal(res4.statusCode, 403, 'Should return 403 for Foundry token');
    assert(
        (res4.payload as any)?.reason?.includes('Service tokens and Foundry sessions'),
        'Should mention Foundry/service in error message'
    );

    // Test 5: Service token (long opaque string) explicitly rejected
    console.log('  Test 5: Service token explicitly rejected');
    const serviceToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzY29wZSI6InN5cy5hZG1pbiJ9.ABCDEF123456'; // Long token-like string
    const req5 = createRequestStub(`Bearer ${serviceToken}`);
    const res5 = createResponseStub();
    let nextCalled5 = false;
    const next5: NextFunction = () => {
        nextCalled5 = true;
    };

    requireAdminAuth(req5, res5 as unknown as Response, next5);
    assert.equal(nextCalled5, false, 'Service token should not call next()');
    assert.equal(res5.statusCode, 403, 'Should return 403 for service token');

    // Test 6: Wrong principal type rejected
    console.log('  Test 6: Wrong principal type rejected');
    const wrongPrincipalClaims = {
        principalType: 'user' as any,
        adminId: 'user-1',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 15 * 60 * 1000,
    };
    const wrongPrincipalToken = serializeSessionClaims(wrongPrincipalClaims);
    const req6 = createRequestStub(`Bearer ${wrongPrincipalToken}`);
    const res6 = createResponseStub();
    let nextCalled6 = false;
    const next6: NextFunction = () => {
        nextCalled6 = true;
    };

    requireAdminAuth(req6, res6 as unknown as Response, next6);
    assert.equal(nextCalled6, false, 'Wrong principal type should not call next()');
    assert.equal(res6.statusCode, 403, 'Should return 403 for wrong principal type');

    // Test 7: Token via custom header
    console.log('  Test 7: Token via custom header accepted');
    const req7 = { headers: { 'x-admin-token': `Bearer ${adminToken}` }, ip: '127.0.0.1' } as unknown as Request;
    const res7 = createResponseStub();
    let nextCalled7 = false;
    const next7: NextFunction = () => {
        nextCalled7 = true;
    };

    requireAdminAuth(req7, res7 as unknown as Response, next7);
    assert.equal(nextCalled7, true, 'Token via custom header should call next()');

    adminSessionManager.shutdown();
    console.log('  All admin auth middleware tests passed!');
}

export function run(): Promise<void> {
    return runAdminAuthMiddlewareTests();
}
