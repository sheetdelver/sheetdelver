import { strict as assert } from 'node:assert';
import {
    compileModuleRoutePattern,
    createModuleProxyService,
} from '@server/services/modules/ModuleProxyService';
import type { ModuleRuntime } from '@shared/sdk/runtime';

function makeRuntime(moduleId: string): ModuleRuntime {
    return {
        moduleId,
        logger: {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
        },
        foundryUrl: '',
        dataStore: {} as never,
        compendium: {} as never,
        documents: {} as never,
    };
}

function makeClient(userId: string | null) {
    return {
        userId,
        isConnected: true,
        url: 'http://foundry.test',
        on: () => {},
        off: () => {},
        dispatchDocument: async () => ({ result: [] }),
        dispatchDocumentSocket: async () => ({ result: [] }),
        fetchByUuid: async () => null,
        roll: async () => ({}),
        useItem: async () => true,
        createChatMessage: async () => ({ result: [] }),
    } as never;
}

export async function run() {
    const standardDynamic = compileModuleRoutePattern('actors/[id]/items');
    assert.equal(standardDynamic.test('actors/abc123/items'), true);
    assert.equal(standardDynamic.test('actors/abc123/items/extra'), false);

    const escapedStatic = compileModuleRoutePattern('spell.table+v2/(draft)?/[id]');
    assert.equal(escapedStatic.test('spell.table+v2/(draft)?/table-1'), true);
    assert.equal(escapedStatic.test('spellxtable+v2/(draft)?/table-1'), false);
    assert.equal(escapedStatic.test('spell.table+v2/draft/table-1'), false);

    const multiDynamic = compileModuleRoutePattern('fetch/[pack]/document/[uuid]');
    assert.equal(multiDynamic.test('fetch/core-items/document/Compendium.foo.bar.Baz'), true);
    assert.equal(multiDynamic.test('fetch/core-items/document'), false);

    let lookupCount = 0;
    const service = createModuleProxyService({
        getServerModule: async () => {
            lookupCount++;
            return {
                apiRoutes: {
                    ping: async (req) => ({
                        status: 201,
                        json: async () => ({
                            ok: true,
                            moduleId: req.runtime.moduleId,
                            userId: req.userSession?.userId,
                            accessUserId: req.getAccessContext().userId,
                        }),
                    }),
                },
            };
        },
        getBaseRuntime: async (moduleId) => makeRuntime(moduleId),
    });

    const baseRequest = {
        path: '/test-system/ping',
        method: 'POST',
        url: '/api/modules/test-system/ping',
        headers: {},
        body: {},
    };

    const missingSession = await service.dispatchModuleRoute({
        ...baseRequest,
        foundryClient: makeClient('user-1'),
    });
    assert.equal(missingSession.status, 403);
    assert.match((missingSession.payload as { error: string }).error, /Foundry user session/);
    assert.equal(lookupCount, 0, 'non-user module API request must not load module handlers');

    const mismatchedSession = await service.dispatchModuleRoute({
        ...baseRequest,
        foundryClient: makeClient('transport-user'),
        userSession: { userId: 'session-user', username: 'Session User', client: makeClient('session-user') },
    });
    assert.equal(mismatchedSession.status, 403);
    assert.match((mismatchedSession.payload as { error: string }).error, /does not match/);
    assert.equal(lookupCount, 0, 'mismatched session must not load module handlers');

    const ok = await service.dispatchModuleRoute({
        ...baseRequest,
        foundryClient: makeClient('user-1'),
        userSession: { userId: 'user-1', username: 'User One', client: makeClient('user-1') },
    });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.payload, {
        ok: true,
        moduleId: 'test-system',
        userId: 'user-1',
        accessUserId: 'user-1',
    });
    assert.equal(lookupCount, 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => {
            console.log('module-proxy-matcher.test.ts passed');
        })
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
