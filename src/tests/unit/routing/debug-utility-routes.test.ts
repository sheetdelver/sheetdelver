import { strict as assert } from 'node:assert';
import type { Request, RequestHandler, Response } from 'express';
import { registerDebugRoutes } from '@server/routes/debug/registerDebugRoutes';
import { registerUtilityRoutes } from '@server/routes/protected/registerUtilityRoutes';

interface RouteMap {
    get: Map<string, RequestHandler[]>;
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
    };
}

function createRouteClient(fetchByUuid: (uuid: string) => Promise<unknown>) {
    return {
        fetchByUuid,
        resolveUrl: (url?: string) => url || '',
    } as any;
}

async function runUtilityRouteSmokeTests() {
    const routeMap: RouteMap = { get: new Map() };
    registerUtilityRoutes(createRouterStub(routeMap) as any, {
        getFallbackSharedContentClient: () => createRouteClient(async () => null),
    });

    assert.equal(routeMap.get.has('/foundry/document'), true);
    assert.equal(routeMap.get.has('/session/users'), true);
    assert.equal(routeMap.get.has('/shared-content'), true);

    const documentHandlers = routeMap.get.get('/foundry/document');
    assert.ok(documentHandlers);

    const missingUuidRes = createResponseStub();
    await documentHandlers![0](
        {
            query: {},
            foundryClient: createRouteClient(async () => null),
        } as unknown as Request,
        missingUuidRes as unknown as Response,
        (() => undefined) as any,
    );
    assert.equal(missingUuidRes.statusCode, 400);
    assert.deepEqual(missingUuidRes.payload, { error: 'Missing uuid' });

    const foundDocumentRes = createResponseStub();
    await documentHandlers![0](
        {
            query: { uuid: 'Actor.actor-1' },
            foundryClient: createRouteClient(async () => ({ id: 'actor-1' })),
        } as unknown as Request,
        foundDocumentRes as unknown as Response,
        (() => undefined) as any,
    );
    assert.deepEqual(foundDocumentRes.payload, { id: 'actor-1' });
}

async function runDebugRouteSmokeTests() {
    const routeMap: RouteMap = { get: new Map() };
    registerDebugRoutes(createRouterStub(routeMap) as any, {
        getOrRestoreSession: async () => undefined,
    });

    assert.equal(routeMap.get.has('/api/debug/actor/:id'), true);
    const handlers = routeMap.get.get('/api/debug/actor/:id');
    assert.ok(handlers);

    const missingAuthRes = createResponseStub();
    await handlers![0](
        { headers: {}, params: { id: 'actor-1' } } as unknown as Request,
        missingAuthRes as unknown as Response,
        (() => undefined) as any,
    );
    assert.equal(missingAuthRes.statusCode, 401);
    assert.deepEqual(missingAuthRes.payload, { error: 'Unauthorized: Missing Session Token' });

    const invalidSessionRes = createResponseStub();
    await handlers![0](
        {
            headers: { authorization: 'Bearer invalid' },
            params: { id: 'actor-1' },
        } as unknown as Request,
        invalidSessionRes as unknown as Response,
        (() => undefined) as any,
    );
    assert.equal(invalidSessionRes.statusCode, 401);
    assert.deepEqual(invalidSessionRes.payload, { error: 'Unauthorized: Invalid or Expired Session' });
}

export async function run() {
    await runUtilityRouteSmokeTests();
    await runDebugRouteSmokeTests();
    console.log('  - Debug/Utility route smoke: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('debug-utility-routes.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
