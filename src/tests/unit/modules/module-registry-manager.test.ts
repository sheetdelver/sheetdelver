import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    __resetRegistryForTests,
    disableModule,
    enableModule,
    getAdapter,
    getServerModule,
    initializeRegistry,
    listModules,
    refreshRegistry,
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
        getLocalModulesDataDir,
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
            },
            dualsource: {
                moduleId: 'dualsource',
                title: 'Dual Source Test',
                directory: 'stale-local-directory',
                activeSource: 'local',
                status: 'disabled',
                enabled: false,
                reason: 'Stale shared lifecycle state',
                localEnabled: true,
                managedEnabled: false,
                sourceStates: {
                    local: { status: 'disabled', enabled: false },
                    managed: { status: 'validated', enabled: true },
                },
                firstSeenAt: 1,
                lastSeenAt: 1,
                updatedAt: 1
            }
        }
    };

    fs.writeFileSync(stateFilePath, JSON.stringify(seededState, null, 2), 'utf8');
    process.env.SHEET_DELVER_MODULE_STATE_FILE = stateFilePath;

    // The managed fixture includes a valid extensionless server entry plus
    // warning-only deprecated drift so both compatibility paths stay covered.
    const testModulesDir = getModulesDataDir();
    const shadowdarkDir = path.join(testModulesDir, 'shadowdark');
    const brokenDir = path.join(testModulesDir, 'brokenmod');
    const badAdapterDir = path.join(testModulesDir, 'badadapter');
    const managedDualDir = path.join(testModulesDir, 'dualsource');
    const localDualDir = path.join(getLocalModulesDataDir(), 'dualsource');
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
    const serverPath = path.join(shadowdarkDir, 'module', 'server.ts');
    fs.mkdirSync(path.dirname(serverPath), { recursive: true });
    fs.writeFileSync(
        serverPath,
        'const foundryClient = null; export const apiRoutes = { index: async () => ({ ok: foundryClient === null }) };',
        'utf8',
    );

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

    fs.mkdirSync(path.join(badAdapterDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(badAdapterDir, 'info.json'), JSON.stringify({
        id: 'badadapter',
        title: 'Bad Adapter Test',
        version: '1.0.0',
        manifest: {
            ui: 'dist/ui.js',
            logic: 'dist/logic.js',
        },
    }), 'utf8');
    fs.writeFileSync(path.join(badAdapterDir, 'dist', 'ui.js'), 'export default function UI() {}', 'utf8');
    fs.writeFileSync(path.join(badAdapterDir, 'dist', 'logic.js'), 'export const notAnAdapter = true;', 'utf8');

    // Reproduce the field contradiction observed after package/local source
    // operations: per-source intent says local on and managed off, while the
    // shared and sourceStates fields contain the opposite stale values.
    for (const [directory, sourceLabel] of [
        [managedDualDir, 'managed'],
        [localDualDir, 'local'],
    ] as const) {
        fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'info.json'), JSON.stringify({
            id: 'dualsource',
            title: 'Dual Source Test',
            version: '1.0.0',
            manifest: {
                ui: 'src/ui.ts',
                logic: 'src/adapter.ts',
            },
        }), 'utf8');
        fs.writeFileSync(
            path.join(directory, 'src', 'adapter.ts'),
            `export default class DualSourceAdapter { source = '${sourceLabel}'; }`,
            'utf8',
        );
        fs.writeFileSync(path.join(directory, 'src', 'ui.ts'), 'export default function UI() {}', 'utf8');
    }

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

        const dualsource = modules.find((entry) => entry.info.id === 'dualsource');
        assert.ok(dualsource);
        assert.equal(dualsource?.lifecycle.activeSource, 'local');
        assert.equal(dualsource?.enabled, true, 'local per-source intent repairs stale shared disabled state');
        assert.equal(dualsource?.lifecycle.localEnabled, true);
        assert.equal(dualsource?.lifecycle.managedEnabled, false);
        assert.equal(dualsource?.lifecycle.sourceStates?.local?.enabled, true);
        assert.equal(dualsource?.lifecycle.sourceStates?.managed?.enabled, false);
        assert.equal(dualsource?.managed, true, 'managed discovery does not depend on artifact metadata');

        const localAdapter = await getAdapter('dualsource');
        assert.equal((localAdapter as unknown as { source?: string }).source, 'local');

        fs.rmSync(localDualDir, { recursive: true, force: true });
        refreshRegistry();
        const packageFallback = listModules({ includeExperimental: true, includeDisabled: true })
            .find((entry) => entry.info.id === 'dualsource');
        assert.equal(packageFallback?.lifecycle.activeSource, 'managed', 'removed local source selects the package');
        assert.equal(packageFallback?.lifecycle.localDirectory, undefined, 'removed local source is not shown as present');
        assert.equal(packageFallback?.enabled, false, 'managed source retains its independent disabled state');

        const failedAdapter = await getAdapter('badadapter');
        assert.equal(failedAdapter?.systemId, 'generic', 'adapter export failure falls back for the current request');
        const failedModule = listModules({ includeExperimental: true, includeDisabled: true })
            .find((entry) => entry.info.id === 'badadapter');
        assert.equal(failedModule?.status, 'errored');
        assert.equal(failedModule?.enabled, false);
        assert.equal(failedModule?.lifecycle.managedEnabled, false);

        const disabledAdapter = await getAdapter('shadowdark');
        assert.equal(disabledAdapter?.systemId, 'generic', 'disabled modules use the internal fallback adapter');

        const enableOk = enableModule('shadowdark');
        assert.equal(enableOk, true);

        const enabledAdapter = await getAdapter('shadowdark');
        assert.ok(enabledAdapter);
        const enabledServer = await getServerModule('shadowdark');
        assert.ok(enabledServer?.apiRoutes?.index, 'extensionless manifest.server resolves module/server.ts');

        const disableOk = disableModule('shadowdark', 'Disabled by registry-manager test');
        assert.equal(disableOk, true);

        const disabledAgain = await getAdapter('shadowdark');
        assert.equal(disabledAgain?.systemId, 'generic');

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
