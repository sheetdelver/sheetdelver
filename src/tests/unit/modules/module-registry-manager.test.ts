import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    __resetRegistryForTests,
    disableModule,
    enableModule,
    getAdapter,
    initializeRegistry,
    listModules,
} from '@modules/registry/server';

function mkTempStateFilePath() {
    return path.join(os.tmpdir(), `sheet-delver-registry-state-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

export async function run() {
    const previousStateFile = process.env.SHEET_DELVER_MODULE_STATE_FILE;
    const stateFilePath = mkTempStateFilePath();
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
    const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-registry-data-'));
    initDataDir(testDataDir);

    const seededState = {
        version: 1,
        modules: {
            shadowdark: {
                moduleId: 'shadowdark',
                title: 'Shadowdark RPG',
                directory: 'shadowdark',
                status: 'disabled',
                enabled: false,
                reason: 'Disabled in test seed',
                validation: {
                    manifestValid: true,
                    compatible: true,
                    coreVersion: '0.0.0'
                },
                firstSeenAt: 1,
                lastSeenAt: 1,
                updatedAt: 1
            }
        }
    };

    fs.writeFileSync(stateFilePath, JSON.stringify(seededState, null, 2), 'utf8');
    process.env.SHEET_DELVER_MODULE_STATE_FILE = stateFilePath;

    // The managed fixture deliberately has a missing optional server entry so the
    // registry records warning-only drift while still allowing the module to enable.
    const testModulesDir = getModulesDataDir();
    const shadowdarkDir = path.join(testModulesDir, 'shadowdark');
    const brokenDir = path.join(testModulesDir, 'brokenmod');
    if (!fs.existsSync(shadowdarkDir)) {
        fs.mkdirSync(shadowdarkDir, { recursive: true });
    }
    fs.writeFileSync(path.join(shadowdarkDir, 'info.json'), JSON.stringify({
        id: 'shadowdark',
        title: 'Shadowdark RPG',
        version: '1.0.0',
        manifest: {
            ui: 'src/ui/index.tsx',
            logic: 'src/server/ShadowdarkAdapter.ts',
            server: 'module/server'
        }
    }), 'utf8');

    // Create dummy adapter file
    const adapterPath = path.join(shadowdarkDir, 'src', 'server', 'ShadowdarkAdapter.ts');
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, 'export default class ShadowdarkAdapter {}', 'utf8');
    const uiPath = path.join(shadowdarkDir, 'src', 'ui', 'index.tsx');
    fs.mkdirSync(path.dirname(uiPath), { recursive: true });
    fs.writeFileSync(uiPath, 'export default function ShadowdarkSheet() { return null; }', 'utf8');

    // Broken fixture omits the required UI entry; this should surface as a blocking
    // artifact error and prevent enable without hiding the module from admin.
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'info.json'), JSON.stringify({
        id: 'brokenmod',
        title: 'Broken Test Module',
        version: '1.0.0',
        manifest: {
            ui: 'dist/ui.js',
            logic: 'dist/logic.js',
        }
    }), 'utf8');
    const brokenLogicPath = path.join(brokenDir, 'dist', 'logic.js');
    fs.mkdirSync(path.dirname(brokenLogicPath), { recursive: true });
    fs.writeFileSync(brokenLogicPath, 'export default class BrokenAdapter {}', 'utf8');

    try {
        __resetRegistryForTests();
        initializeRegistry();

        const modules = listModules({ includeExperimental: true, includeDisabled: true });
        const shadowdark = modules.find((entry) => entry.info.id === 'shadowdark');
        assert.ok(shadowdark);
        assert.equal(shadowdark?.enabled, false);
        assert.equal(shadowdark?.status, 'disabled');
        assert.equal(
            shadowdark?.lifecycle.sourceStates?.managed?.validation?.artifactDiagnostics?.some(diagnostic => diagnostic.severity === 'warning'),
            true,
            'warning-only packaged artifact drift should be visible in lifecycle diagnostics',
        );
        assert.equal(
            shadowdark?.lifecycle.sourceStates?.managed?.validation?.artifactDiagnostics?.some(diagnostic => diagnostic.severity === 'error'),
            false,
            'warning-only packaged artifact drift should not be treated as blocking',
        );

        const broken = modules.find((entry) => entry.info.id === 'brokenmod');
        assert.ok(broken);
        assert.equal(broken?.enabled, false);
        assert.equal(broken?.status, 'errored');
        assert.equal(
            broken?.lifecycle.sourceStates?.managed?.validation?.artifactDiagnostics?.some(diagnostic => diagnostic.code === 'artifact.entry.ui.missing'),
            true,
        );

        const disabledAdapter = await getAdapter('shadowdark');
        assert.equal(disabledAdapter, null);

        const enableOk = enableModule('shadowdark');
        assert.equal(enableOk, true);

        const enabledAdapter = await getAdapter('shadowdark');
        assert.ok(enabledAdapter);

        const disableOk = disableModule('shadowdark', 'Disabled by registry-manager test');
        assert.equal(disableOk, true);

        const disabledAgain = await getAdapter('shadowdark');
        assert.equal(disabledAgain, null);

        const brokenEnableOk = enableModule('brokenmod');
        assert.equal(brokenEnableOk, false);

        const genericDisable = disableModule('generic', 'should fail');
        assert.equal(genericDisable, false);
    } finally {
        __resetRegistryForTests();
        if (previousStateFile) {
            process.env.SHEET_DELVER_MODULE_STATE_FILE = previousStateFile;
        } else {
            delete process.env.SHEET_DELVER_MODULE_STATE_FILE;
        }
        if (fs.existsSync(stateFilePath)) {
            fs.unlinkSync(stateFilePath);
        }
        __resetDataDirForTests(previousDataDir);
        fs.rmSync(testDataDir, { recursive: true, force: true });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => {
            console.log('module-registry-manager.test.ts passed');
        })
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
