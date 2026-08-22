import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    __resetRegistryForTests,
    getModuleLifecycleState,
    initializeRegistry,
    recordModuleRuntimeFailure,
} from '@modules/registry/server';
import { createModuleRouter } from '@server/routes/modules/createModuleRouter';
import { createResponseStub } from '../routing/route-test-helpers';
import { ModuleUiHealthRateLimiter, sanitizeModuleUiHealthText } from '@server/security/moduleUiHealthPolicy';
import type { RequestHandler } from 'express';

const STATE_ENV = 'SHEET_DELVER_MODULE_STATE_FILE';

function mkTempFile(prefix: string): string {
    return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

function writeJson(filePath: string, value: unknown): void {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function getRouteHandler(router: any, routePath: string): RequestHandler {
    const layer = router.stack.find((entry: any) => entry.route?.path === routePath && entry.route?.methods?.post);
    assert.ok(layer, `expected POST ${routePath}`);
    return layer.route.stack.at(-1).handle;
}

export async function run(): Promise<void> {
    const previousStateFile = process.env[STATE_ENV];
    const {
        __resetDataDirForTests,
        getDataDir,
        getModulesDataDir,
        initDataDir,
    } = await import('../../../server/core/paths');
    let previousDataDir: string | null = null;
    try {
        previousDataDir = getDataDir();
    } catch {
        previousDataDir = null;
    }

    const stateFilePath = mkTempFile('sheet-delver-ui-health-state');
    const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-ui-health-data-'));

    try {
        process.env[STATE_ENV] = stateFilePath;
        initDataDir(testDataDir);

        const moduleDir = path.join(getModulesDataDir(), 'uihealth');
        fs.mkdirSync(path.join(moduleDir, 'dist'), { recursive: true });
        writeJson(path.join(moduleDir, 'info.json'), {
            id: 'uihealth',
            title: 'UI Health Test Module',
            version: '1.0.0',
            manifest: {
                ui: 'dist/ui.js',
                logic: 'dist/logic.js',
            },
        });
        fs.writeFileSync(path.join(moduleDir, 'dist', 'ui.js'), 'export default {};', 'utf8');
        fs.writeFileSync(path.join(moduleDir, 'dist', 'logic.js'), 'export default class Adapter {}', 'utf8');

        __resetRegistryForTests();
        initializeRegistry();

        const router = createModuleRouter({
            tryAuthenticateSession: ((_req, _res, next) => next()) as RequestHandler,
        }) as any;
        const report = getRouteHandler(router, '/:id/ui-error');

        const guestResponse = createResponseStub();
        await report({ params: { id: 'uihealth' }, body: { source: 'managed' } } as any, guestResponse, (() => undefined) as any);
        assert.equal(guestResponse.statusCode, 401);

        const unknownResponse = createResponseStub();
        await report({
            params: { id: 'unknown' },
            body: { source: 'managed' },
            userSession: { id: 'session-1', userId: 'user-1' },
        } as any, unknownResponse, (() => undefined) as any);
        assert.equal(unknownResponse.statusCode, 404);

        const validResponse = createResponseStub();
        await report({
            params: { id: 'UIHEALTH' },
            body: { source: 'managed', message: 'SyntaxError:\n forged log\u0000tail' },
            userSession: { id: 'session-1', userId: 'user-1' },
        } as any, validResponse, (() => undefined) as any);
        assert.equal(validResponse.statusCode, 200);

        const record = getModuleLifecycleState().find(entry => entry.moduleId === 'uihealth');
        assert.ok(record);
        assert.equal(record?.status, 'errored');
        assert.equal(record?.enabled, false);
        assert.equal(record?.health?.errorCount, 1);
        assert.equal(record?.health?.lastError, 'UI load failure (managed): SyntaxError: forged log tail');
        assert.equal(record?.sourceStates?.managed?.health?.lastError, 'UI load failure (managed): SyntaxError: forged log tail');

        const missing = recordModuleRuntimeFailure('missing-uihealth', 'should not create a record');
        assert.equal(missing, false);

        assert.equal(sanitizeModuleUiHealthText(' x\r\ny\t ', 'fallback', 10), 'x y');
        const limiter = new ModuleUiHealthRateLimiter(2, 1_000);
        assert.equal(limiter.consume('session-a', 'uihealth', 1_000), true);
        assert.equal(limiter.consume('session-a', 'uihealth', 1_100), true);
        assert.equal(limiter.consume('session-a', 'uihealth', 1_200), false);
        assert.equal(limiter.consume('session-b', 'uihealth', 1_200), true);
        assert.equal(limiter.consume('session-a', 'other', 1_200), true);
        assert.equal(limiter.consume('session-a', 'uihealth', 2_101), true);
    } finally {
        __resetRegistryForTests();

        if (previousStateFile) process.env[STATE_ENV] = previousStateFile;
        else delete process.env[STATE_ENV];

        __resetDataDirForTests(previousDataDir);
        if (fs.existsSync(stateFilePath)) fs.unlinkSync(stateFilePath);
        fs.rmSync(testDataDir, { recursive: true, force: true });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('module-ui-health-report: PASS'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
