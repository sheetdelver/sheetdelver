import { strict as assert } from 'node:assert';
import path from 'node:path';
import type { RequestHandler } from 'express';
import { registerSystemRoutes } from '@server/routes/protected/registerSystemRoutes';
import { registerAdminAuthRoutes } from '@server/routes/admin/registerAdminAuthRoutes';
import { registerAdminStatusRoutes } from '@server/routes/admin/registerAdminStatusRoutes';
import { registerAdminWorldRoutes } from '@server/routes/admin/registerAdminWorldRoutes';
import { registerAdminModuleRoutes } from '@server/routes/admin/registerAdminModuleRoutes';
import { createModuleRouter } from '@server/routes/modules/createModuleRouter';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { getDataDir, initDataDir, resolveDataDir } from '@server/core/paths';
import { ModuleSourceCategory } from '@shared/types/modules';
import {
    createResponseStub,
    createRouteMap,
    createRouterStub,
    getLastHandler,
    invokeHandler,
} from './route-test-helpers';

function requireAdminAccountExists(_req: unknown, _res: unknown, next: () => void): void {
    next();
}

function seedSystemState(): void {
    worldStateStore.seed({
        world: { id: 'world-1', title: 'World One', system: 'synthetic' },
        system: { id: 'synthetic', title: 'Synthetic System', version: '1.0.0' },
        modules: [],
        scenes: [{ _id: 'scene-1', name: 'Scene One' }],
    } as any, {
        sceneData: { 'scene-1': { _id: 'scene-1', name: 'Scene One' } },
    });
}

function ensureDataDirInitialized(): void {
    try {
        getDataDir();
    } catch {
        initDataDir(resolveDataDir(['--data-dir', path.join(process.cwd(), 'temp', 'route-test-data')]));
    }
}

async function runSystemRouteSmokeTests() {
    const routeMap = createRouteMap();
    registerSystemRoutes(createRouterStub(routeMap) as any, {
        getSystemClient: () => ({ id: 'system-client' }),
        getAdapter: async () => ({
            getSystemData: async () => ({ adapter: 'synthetic' }),
        } as any),
    });

    assert.equal(routeMap.get.has('/system'), true);
    assert.equal(routeMap.get.has('/system/data'), true);
    assert.equal(routeMap.get.has('/system/scenes'), true);

    seedSystemState();

    const systemRes = await invokeHandler(getLastHandler(routeMap, 'get', '/system'), {});
    assert.deepEqual(systemRes.payload, { id: 'synthetic', title: 'Synthetic System', version: '1.0.0' });

    const dataRes = await invokeHandler(getLastHandler(routeMap, 'get', '/system/data'), {});
    assert.deepEqual(dataRes.payload, { adapter: 'synthetic' });

    const scenesRes = await invokeHandler(getLastHandler(routeMap, 'get', '/system/scenes'), {});
    assert.deepEqual(scenesRes.payload, { 'scene-1': { _id: 'scene-1', name: 'Scene One' } });

    worldStateStore.clear('admin-system-module-routes-test');
    const missingScenesRes = await invokeHandler(getLastHandler(routeMap, 'get', '/system/scenes'), {});
    assert.equal(missingScenesRes.statusCode, 404);
    assert.deepEqual(missingScenesRes.payload, { error: 'Scene data not available' });
}

async function runAdminStatusRouteSmokeTests() {
    const routeMap = createRouteMap();
    registerAdminStatusRoutes({
        adminRouter: createRouterStub(routeMap) as any,
        requireAdminAccountExists: requireAdminAccountExists as any,
        adminService: {
            getStatus: async () => ({ success: true, status: 'ok' }),
            listWorlds: async () => [{ id: 'world-1' }],
            getCache: async () => ({ currentWorldId: 'world-1' }),
        } as any,
    });

    assert.equal(routeMap.get.has('/status'), true);
    assert.equal(routeMap.get.has('/worlds'), true);
    assert.equal(routeMap.get.has('/cache'), true);
    assert.equal(routeMap.get.has('/audit'), true);

    const statusRes = await invokeHandler(getLastHandler(routeMap, 'get', '/status'), {});
    assert.deepEqual(statusRes.payload, { success: true, status: 'ok' });

    const worldsRes = await invokeHandler(getLastHandler(routeMap, 'get', '/worlds'), {});
    assert.deepEqual(worldsRes.payload, [{ id: 'world-1' }]);
}

async function runAdminAuthRouteSmokeTests() {
    const routeMap = createRouteMap();
    const adminLoginLimiter: RequestHandler = (_req, _res, next) => next();
    registerAdminAuthRoutes({
        adminRouter: createRouterStub(routeMap) as any,
        requireAdminAccountExists: requireAdminAccountExists as any,
        adminLoginLimiter: adminLoginLimiter as any,
    });

    assert.equal(routeMap.post.has('/auth/setup'), true);
    assert.equal(routeMap.post.has('/auth/login'), true);
    assert.equal(routeMap.post.has('/auth/reset'), true);
    assert.equal(routeMap.get.has('/auth/status'), true);
}

async function runAdminWorldRouteSmokeTests() {
    const routeMap = createRouteMap();
    registerAdminWorldRoutes({
        adminRouter: createRouterStub(routeMap) as any,
        requireAdminAccountExists: requireAdminAccountExists as any,
        adminService: {
            launchWorld: async (worldId: string) => ({ success: true, worldId }),
            shutdownWorld: async () => ({ success: true, shutdown: true }),
        } as any,
    });

    assert.equal(routeMap.post.has('/world/launch'), true);
    assert.equal(routeMap.post.has('/world/shutdown'), true);
    assert.equal(routeMap.post.has('/world/retry'), true);

    const launchRes = await invokeHandler(
        getLastHandler(routeMap, 'post', '/world/launch'),
        { body: { worldId: 'world-1' } } as any,
    );
    assert.deepEqual(launchRes.payload, { success: true, worldId: 'world-1' });

    const shutdownRes = await invokeHandler(getLastHandler(routeMap, 'post', '/world/shutdown'), {});
    assert.deepEqual(shutdownRes.payload, { success: true, shutdown: true });

    const failureMap = createRouteMap();
    registerAdminWorldRoutes({
        adminRouter: createRouterStub(failureMap) as any,
        requireAdminAccountExists: requireAdminAccountExists as any,
        adminService: {
            launchWorld: async () => {
                throw new Error('Foundry rejected request');
            },
            shutdownWorld: async () => ({ success: true }),
        } as any,
    });

    const failureRes = await invokeHandler(
        getLastHandler(failureMap, 'post', '/world/launch'),
        { body: { worldId: 'world-1' } } as any,
    );
    assert.equal(failureRes.statusCode, 500);
    assert.deepEqual(failureRes.payload, { error: 'Foundry rejected request' });
}

async function runAdminModuleRouteSmokeTests() {
    const routeMap = createRouteMap();
    const broadcasts: Array<{ event: string; data: unknown }> = [];
    registerAdminModuleRoutes({
        adminRouter: createRouterStub(routeMap) as any,
        requireAdminAccountExists: requireAdminAccountExists as any,
        broadcastToClients: (event, data) => broadcasts.push({ event, data }),
    });

    assert.equal(routeMap.get.has('/lifecycle'), true);
    assert.equal(routeMap.post.has('/lifecycle/:moduleId/enable'), true);
    assert.equal(routeMap.post.has('/lifecycle/:moduleId/disable'), true);
    assert.equal(routeMap.post.has('/lifecycle/:moduleId/switch-source'), true);
    assert.equal(routeMap.post.has('/manager/:moduleId/dry-run/install'), true);
    assert.equal(routeMap.post.has('/manager/:moduleId/dry-run/upgrade'), true);
    assert.equal(routeMap.get.has('/sources'), true);
    assert.equal(routeMap.post.has('/sources'), true);
    assert.equal(routeMap.put.has('/sources/:id'), true);
    assert.equal(routeMap.delete.has('/sources/:id'), true);
    assert.equal(routeMap.post.has('/server/restart'), true);

    const invalidSourceRes = await invokeHandler(
        getLastHandler(routeMap, 'post', '/lifecycle/:moduleId/switch-source'),
        { params: { moduleId: 'shadowdark' }, body: { source: 'invalid' } } as any,
    );
    assert.equal(invalidSourceRes.statusCode, 400);
    assert.deepEqual(invalidSourceRes.payload, {
        success: false,
        error: `source must be "${ModuleSourceCategory.Local}" or "${ModuleSourceCategory.Managed}"`,
    });
    assert.deepEqual(broadcasts, []);
}

function getExpressRouteHandler(router: any, path: string, method: string): RequestHandler {
    const layer = router.stack.find((entry: any) => entry.route?.path === path && entry.route?.methods?.[method]);
    assert.ok(layer, `expected ${method.toUpperCase()} ${path} to be registered`);
    const stack = layer.route.stack;
    return stack[stack.length - 1].handle;
}

async function runModuleRouterSmokeTests() {
    ensureDataDirInitialized();

    const router = createModuleRouter({
        tryAuthenticateSession: ((_req, _res, next) => next()) as RequestHandler,
    }) as any;

    assert.ok(router.stack.some((entry: any) => !entry.route && entry.name === 'tryAuthenticateSession'), 'auth middleware should be mounted');
    assert.ok(router.stack.some((entry: any) => entry.route?.path === '/:id/ui'), 'UI artifact route should be mounted');
    assert.ok(router.stack.some((entry: any) => entry.route?.path === '/:id/ui-error'), 'UI health report route should be mounted');
    assert.ok(router.stack.some((entry: any) => entry.route?.path === '/:id/assets/{*assetPath}'), 'asset route should be mounted');
    assert.ok(router.stack.some((entry: any) => entry.route?.path instanceof RegExp), 'module proxy catch-all should be mounted');

    const uiHandler = getExpressRouteHandler(router, '/:id/ui', 'get');
    const res = createResponseStub();
    await uiHandler({ params: { id: 'missing-module' } } as any, res, (() => undefined) as any);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.payload, { error: 'Module "missing-module" not found' });

    const uiErrorHandler = getExpressRouteHandler(router, '/:id/ui-error', 'post');
    const uiErrorRes = createResponseStub();
    await uiErrorHandler({
        params: { id: 'missing-module' },
        body: { message: 'Client failed to import module UI', source: 'managed' },
    } as any, uiErrorRes, (() => undefined) as any);
    assert.equal(uiErrorRes.statusCode, 200);
    assert.deepEqual(uiErrorRes.payload, { success: true });
}

export async function run() {
    await runSystemRouteSmokeTests();
    await runAdminAuthRouteSmokeTests();
    await runAdminStatusRouteSmokeTests();
    await runAdminWorldRouteSmokeTests();
    await runAdminModuleRouteSmokeTests();
    await runModuleRouterSmokeTests();
    console.log('  - Admin/System/Module route smoke: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('admin-system-module-routes.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
