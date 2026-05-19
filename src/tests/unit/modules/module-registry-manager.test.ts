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

    // Create dummy module directory in test data
    const { getModulesDataDir } = await import('../../../server/core/paths');
    const testModulesDir = getModulesDataDir();
    const shadowdarkDir = path.join(testModulesDir, 'shadowdark');
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

    try {
        __resetRegistryForTests();
        initializeRegistry();

        const modules = listModules({ includeExperimental: true, includeDisabled: true });
        const shadowdark = modules.find((entry) => entry.info.id === 'shadowdark');
        assert.ok(shadowdark);
        assert.equal(shadowdark?.enabled, false);
        assert.equal(shadowdark?.status, 'disabled');

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
