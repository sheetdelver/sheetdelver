import { strict as assert } from 'node:assert';
import type { Request, Response, NextFunction } from 'express';
import { requireAdminAuth } from '@server/middleware/requireAdminAuth';
import { ADMIN_SESSION_COOKIE_NAME } from '@server/security/adminSessionCookie';
import { adminSessionManager, createAdminSessionClaims } from '@server/security/adminSessionService';

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

function createRequestStub(options: {
    bearer?: string;
    cookie?: string;
} = {}): Request {
    return {
        headers: {
            ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
            ...(options.cookie ? { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${options.cookie}` } : {}),
        },
        ip: '127.0.0.1',
    } as Request;
}

function authenticate(req: Request): { nextCalled: boolean; response: ResponseStub } {
    const response = createResponseStub();
    let nextCalled = false;
    const next: NextFunction = () => {
        nextCalled = true;
    };
    requireAdminAuth(req, response as unknown as Response, next);
    return { nextCalled, response };
}

async function runAdminAuthMiddlewareTests(): Promise<void> {
    console.log('Running admin auth middleware tests...');
    adminSessionManager.initialize();

    const token = adminSessionManager.storeSession(
        createAdminSessionClaims('test-admin', 15 * 60 * 1000),
    );

    const cookieRequest = createRequestStub({ cookie: token });
    const cookieResult = authenticate(cookieRequest);
    assert.equal(cookieResult.nextCalled, true);
    assert.equal(cookieRequest.adminSession?.adminId, 'test-admin');
    assert.equal(cookieRequest.adminSessionToken, token);

    // Trusted loopback tools may present the same opaque credential explicitly.
    assert.equal(authenticate(createRequestStub({ bearer: token })).nextCalled, true);

    const missing = authenticate(createRequestStub());
    assert.equal(missing.nextCalled, false);
    assert.equal(missing.response.statusCode, 401);

    const expiredClaims = createAdminSessionClaims('expired-admin', 15 * 60 * 1000);
    expiredClaims.expiresAt = Date.now() - 1;
    const expiredToken = adminSessionManager.storeSession(expiredClaims);
    assert.equal(authenticate(createRequestStub({ cookie: expiredToken })).response.statusCode, 401);

    // Foundry/service credentials are unknown opaque values and never gain an
    // admin principal through shape or length heuristics.
    const foundryToken = 'a1b2c3d4-e5f6-4789-a123-b456c789d012';
    const serviceToken = 'eyJhbGciOiJIUzI1NiJ9.unrelated.service-token';
    assert.equal(authenticate(createRequestStub({ bearer: foundryToken })).response.statusCode, 401);
    assert.equal(authenticate(createRequestStub({ bearer: serviceToken })).response.statusCode, 401);

    const wrongPrincipal = createAdminSessionClaims('wrong-principal', 15 * 60 * 1000);
    (wrongPrincipal as any).principalType = 'user';
    const wrongPrincipalToken = adminSessionManager.storeSession(wrongPrincipal);
    assert.equal(authenticate(createRequestStub({ bearer: wrongPrincipalToken })).response.statusCode, 401);

    const revokedToken = adminSessionManager.storeSession(
        createAdminSessionClaims('revoke-admin', 15 * 60 * 1000),
    );
    assert.equal(authenticate(createRequestStub({ cookie: revokedToken })).nextCalled, true);
    adminSessionManager.revokeSession(revokedToken);
    assert.equal(authenticate(createRequestStub({ cookie: revokedToken })).response.statusCode, 401);

    const resetToken = adminSessionManager.storeSession(
        createAdminSessionClaims('reset-admin', 15 * 60 * 1000),
    );
    adminSessionManager.revokeAllForAdmin('reset-admin');
    assert.equal(authenticate(createRequestStub({ cookie: resetToken })).response.statusCode, 401);

    adminSessionManager.shutdown();
    console.log('  All admin auth middleware tests passed!');
}

export function run(): Promise<void> {
    return runAdminAuthMiddlewareTests();
}
