import { strict as assert } from 'node:assert';
import type { Request, RequestHandler, Response } from 'express';
import { registerDebugRoutes } from '@server/routes/debug/registerDebugRoutes';
import { registerUtilityRoutes } from '@server/routes/protected/registerUtilityRoutes';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { compendiumStore } from '@server/core/compendium/CompendiumStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { SdkError } from '@shared/sdk/errors';
import {
    DocumentOwnershipLevel,
    FoundryUserRole,
} from '@server/core/documents/primary/base/ownership';

interface RouteMap {
    get: Map<string, RequestHandler[]>;
}

type ResponseStub = {
    statusCode: number;
    payload: unknown;
    headers: Record<string, string>;
    status: (code: number) => Response;
    json: (body: unknown) => Response;
    setHeader: (name: string, value: string) => Response;
};

function createResponseStub(): ResponseStub {
    const state: ResponseStub = {
        statusCode: 200,
        payload: undefined,
        headers: {},
        status(code: number) {
            state.statusCode = code;
            return state as unknown as Response;
        },
        json(body: unknown) {
            state.payload = body;
            return state as unknown as Response;
        },
        setHeader(name: string, value: string) {
            state.headers[name] = value;
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

function createRouteClient(
    fetchByUuid: (uuid: string) => Promise<unknown>,
    userId = 'player-1',
) {
    return {
        userId,
        fetchByUuid,
        resolveUrl: (url?: string) => url || '',
    } as any;
}

async function runUtilityRouteSmokeTests() {
    // The generic UUID route must resolve through caller-scoped stores; the
    // client's raw UUID resolver is privileged and deliberately forged here.
    await userStore.seed(async () => [
        { _id: 'player-1', name: 'Player', role: FoundryUserRole.PLAYER },
    ]);
    await actorStore.seed(async () => ([
        {
            _id: 'actor-observed',
            name: 'Observed',
            ownership: { default: DocumentOwnershipLevel.NONE, 'player-1': DocumentOwnershipLevel.OBSERVER },
        },
        { _id: 'actor-hidden', name: 'Hidden', ownership: { default: DocumentOwnershipLevel.NONE } },
    ] as import('@server/shared/types/actors').ActorDocument[]));

    const routeMap: RouteMap = { get: new Map() };
    registerUtilityRoutes(createRouterStub(routeMap) as any);

    assert.equal(routeMap.get.has('/foundry/document'), true);
    assert.equal(routeMap.get.has('/session/users'), true);
    assert.equal(routeMap.get.has('/shared-content'), true);

    const documentHandlers = routeMap.get.get('/foundry/document');
    assert.ok(documentHandlers);

    try {
        await settingStore.seed(async () => []);
        worldStateStore.seed({ world: { id: 'fixture' }, release: { generation: 14 } });
        const pack = 'world.arbitrary';
        const packMetadata = (readable: boolean) => compendiumStore.setPackMetadata(pack, { id: pack, type: 'Actor', ownership: { PLAYER: readable ? 'OBSERVER' : 'NONE' } });
        const getPack = async (resolve: () => Promise<unknown>) => {
            const response = createResponseStub();
            await documentHandlers![0]({ query: { uuid: `Compendium.${pack}.Actor.row` }, foundryClient: createRouteClient(resolve) } as any, response as any, (() => {}) as any);
            return response;
        };
        packMetadata(false); let rawReads = 0;
        const denied = await getPack(async () => { rawReads++; return { private: true }; });
        assert.equal(denied.statusCode, 403, 'expected SDK denial is not an internal server failure'); assert.equal(rawReads, 0);
        assert.equal((denied.payload as any).code, 'permission_denied');
        packMetadata(true);
        const revoked = await getPack(async () => { packMetadata(false); return { private: true }; });
        assert.equal(revoked.statusCode, 403); assert.equal((revoked.payload as any).private, undefined);
        packMetadata(true);
        assert.equal((await getPack(async () => null)).statusCode, 404);
        assert.equal((await getPack(async () => { throw new Error('secret upstream detail'); })).statusCode, 500);
        assert.equal((await getPack(async () => { throw new SdkError('permission_denied', 'Pack access changed'); })).statusCode, 403);
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
                query: { uuid: 'Actor.actor-observed' },
                foundryClient: createRouteClient(async () => ({ forged: true })),
            } as unknown as Request,
            foundDocumentRes as unknown as Response,
            (() => undefined) as any,
        );
        assert.equal((foundDocumentRes.payload as any).name, 'Observed');
        assert.equal((foundDocumentRes.payload as any).forged, undefined);

        const hiddenDocumentRes = createResponseStub();
        await documentHandlers![0](
            {
                query: { uuid: 'Actor.actor-hidden' },
                foundryClient: createRouteClient(async () => ({ forged: true })),
            } as unknown as Request,
            hiddenDocumentRes as unknown as Response,
            (() => undefined) as any,
        );
        assert.equal(hiddenDocumentRes.statusCode, 404);

        const usersRes = createResponseStub();
        await routeMap.get.get('/session/users')![0](
            {
                foundryClient: createRouteClient(async () => null),
                userSession: { userId: 'player-1' },
                isSystem: false,
            } as unknown as Request,
            usersRes as unknown as Response,
            (() => undefined) as any,
        );
        assert.equal(usersRes.headers['Cache-Control'], 'no-store');
        assert.equal((usersRes.payload as { currentUserId?: string }).currentUserId, 'player-1');
        assert.equal(JSON.stringify(usersRes.payload).includes('session-token'), false);
    } finally {
        actorStore.clear('debug-utility-routes-test');
        userStore.clear('debug-utility-routes-test');
    }
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
