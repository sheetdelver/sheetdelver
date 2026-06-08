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

const STATE_ENV = 'SHEET_DELVER_MODULE_STATE_FILE';

function mkTempFile(prefix: string): string {
    return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

function writeJson(filePath: string, value: unknown): void {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
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

        const recorded = recordModuleRuntimeFailure('uihealth', 'UI load failure (data): SyntaxError: bad import');
        assert.equal(recorded, true);

        const record = getModuleLifecycleState().find(entry => entry.moduleId === 'uihealth');
        assert.ok(record);
        assert.equal(record?.status, 'errored');
        assert.equal(record?.enabled, false);
        assert.equal(record?.health?.errorCount, 1);
        assert.equal(record?.health?.lastError, 'UI load failure (data): SyntaxError: bad import');
        assert.equal(record?.sourceStates?.data?.health?.lastError, 'UI load failure (data): SyntaxError: bad import');

        const missing = recordModuleRuntimeFailure('missing-uihealth', 'should not create a record');
        assert.equal(missing, false);
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
