import { strict as assert } from 'node:assert';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { registerPublicRoutes } from '@server/routes/public/registerPublicRoutes';
import { createAuthenticateSession } from '@server/middleware/authenticateSession';

interface RouteMap {
    get: Map<string, RequestHandler[]>;
    post: Map<string, RequestHandler[]>;
}

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

function createRouterStub(routeMap: RouteMap) {
    return {
        get(path: string, ...handlers: RequestHandler[]) {
            routeMap.get.set(path, handlers);
            return this;
        },
        post(path: string, ...handlers: RequestHandler[]) {
            routeMap.post.set(path, handlers);
            return this;
        },
    };
}

function createMockRouteClient(userId = 'user-1') {
    const noop = async () => undefined;
    return {
        userId,
        on: () => undefined,
        off: () => undefined,
        getSystem: noop,
        getActors: noop,
        getActor: noop,
        createActor: noop,
        deleteActor: noop,
        updateActor: noop,
        roll: noop,
        useItem: noop,
        createActorItem: noop,
        updateActorItem: noop,
        deleteActorItem: noop,
        resolveUrl: (url?: string) => url || '',
        createChatMessage: noop,
        dispatchDocument: noop,
        dispatchDocumentSocket: noop,
        fetchByUuid: noop,
        getSharedContent: () => null,
    };
}

async function runPublicRouteSmokeTests() {
    const routeMap: RouteMap = {
        get: new Map(),
        post: new Map(),
    };

    const statusHandler: RequestHandler = (req, res) => {
        res.json({ connected: true });
    };

    const loginLimiter: RequestHandler = (_req, _res, next) => next();

    let destroyedToken: string | null = null;

    const deps = {
        statusHandler,
        getSanitizedConfig: () => ({ app: { version: '0.0.0-test' } }),
        getSetupStatus: async () => ({ isConfigured: true }),
        loginLimiter,
        createSession: async (username: string) => ({
            sessionId: `token-${username}`,
            userId: 'user-123',
        }),
        destroySession: async (token: string) => {
            destroyedToken = token;
        },
    };

    registerPublicRoutes(createRouterStub(routeMap) as any, deps);

    assert.equal(routeMap.get.has('/status'), true);
    assert.equal(routeMap.get.has('/session/connect'), true);
    assert.equal(routeMap.get.get('/status')?.[0], statusHandler);
    assert.equal(routeMap.get.get('/session/connect')?.[0], statusHandler);

    const setupStatusHandlers = routeMap.get.get('/config/setup-status');
    assert.ok(setupStatusHandlers && setupStatusHandlers.length === 1);
    const setupStatusRes = createResponseStub();
    await setupStatusHandlers![0]({} as Request, setupStatusRes as unknown as Response, (() => undefined) as NextFunction);
    assert.deepEqual(setupStatusRes.payload, { isConfigured: true });

    const loginHandlers = routeMap.post.get('/login');
    assert.ok(loginHandlers && loginHandlers.length === 2);
    assert.equal(loginHandlers![0], loginLimiter);

    const loginReq = { body: { username: 'tester', password: 'secret' } } as Request;
    const loginRes = createResponseStub();
    await loginHandlers![1](loginReq, loginRes as unknown as Response, (() => undefined) as NextFunction);
    assert.deepEqual(loginRes.payload, { success: true, token: 'token-tester', userId: 'user-123' });

    const failingDeps = {
        ...deps,
        createSession: async () => {
            throw new Error('bad credentials');
        },
    };

    const failingRouteMap: RouteMap = {
        get: new Map(),
        post: new Map(),
    };

    registerPublicRoutes(createRouterStub(failingRouteMap) as any, failingDeps);
    const failingLoginHandlers = failingRouteMap.post.get('/login');
    const failingRes = createResponseStub();
    await failingLoginHandlers![1](loginReq, failingRes as unknown as Response, (() => undefined) as NextFunction);
    assert.equal(failingRes.statusCode, 401);
    assert.deepEqual(failingRes.payload, { success: false, error: 'bad credentials' });

    const logoutHandlers = routeMap.post.get('/logout');
    assert.ok(logoutHandlers && logoutHandlers.length === 1);
    const logoutReq = {
        headers: { authorization: 'Bearer abc123' },
    } as unknown as Request;
    const logoutRes = createResponseStub();
    await logoutHandlers![0](logoutReq, logoutRes as unknown as Response, (() => undefined) as NextFunction);
    assert.equal(destroyedToken, 'abc123');
    assert.deepEqual(logoutRes.payload, { success: true });
}

async function runProtectedRouteAuthAssertion() {
    const sessionManager = {
        getOrRestoreSession: async (token: string) => {
            if (token !== 'valid-token') return undefined;
            return {
                id: 'session-1',
                userId: 'user-1',
                username: 'tester',
                client: createMockRouteClient('user-1'),
            };
        },
    } as any;

    const config = {
        security: {
            serviceToken: undefined,
        },
    } as any;

    const middleware = createAuthenticateSession(sessionManager, config);

    const missingAuthReq = {
        url: '/actors',
        headers: {},
    } as Request;
    const missingAuthRes = createResponseStub();
    let missingNextCalled = false;

    middleware(
        missingAuthReq,
        missingAuthRes as unknown as Response,
        (() => {
            missingNextCalled = true;
        }) as NextFunction
    );

    assert.equal(missingNextCalled, false);
    assert.equal(missingAuthRes.statusCode, 401);
    assert.deepEqual(missingAuthRes.payload, { error: 'Unauthorized: Missing Session Token' });

    const validReq = {
        url: '/actors',
        headers: { authorization: 'Bearer valid-token' },
    } as unknown as Request;
    const validRes = createResponseStub();

    await new Promise<void>((resolve) => {
        middleware(
            validReq,
            validRes as unknown as Response,
            (() => {
                resolve();
            }) as NextFunction
        );
    });

    assert.ok(validReq.foundryClient);
    assert.equal(validReq.isSystem, false);
    assert.equal(validReq.userSession?.userId, 'user-1');
}

export async function run() {
    await runPublicRouteSmokeTests();
    await runProtectedRouteAuthAssertion();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('auth-status-smoke.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
