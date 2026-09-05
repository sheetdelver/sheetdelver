import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    createEmptyLifecycleStore,
    getLifecycleRecords,
    loadLifecycleStore,
    ModuleSourceCategory,
    recordLifecycleRuntimeFailure,
    saveLifecycleStore,
    upsertDiscoveredModule,
} from '@modules/registry/lifecycle';

function mkTempStateFilePath() {
    return path.join(os.tmpdir(), `sheet-delver-lifecycle-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

export function run() {
    const stateFilePath = mkTempStateFilePath();
    const legacyStateFilePath = mkTempStateFilePath();

    try {
        const initial = loadLifecycleStore(stateFilePath);
        assert.equal(initial.version, 1);
        assert.equal(Object.keys(initial.modules).length, 0);

        fs.writeFileSync(legacyStateFilePath, JSON.stringify({
            version: 1,
            modules: {
                legacy: {
                    moduleId: 'legacy',
                    title: 'Legacy',
                    directory: 'legacy',
                    activeSource: 'data',
                    status: 'validated',
                    enabled: true,
                    sourceStates: {
                        data: {
                            status: 'validated',
                            enabled: true,
                            reason: 'old managed source key',
                        },
                        'built-in': {
                            status: 'disabled',
                            enabled: false,
                        },
                    },
                    firstSeenAt: 1,
                    lastSeenAt: 1,
                    updatedAt: 1,
                },
            },
        }), 'utf8');
        const legacy = loadLifecycleStore(legacyStateFilePath);
        assert.equal(legacy.modules.legacy.activeSource, ModuleSourceCategory.Managed);
        assert.equal(legacy.modules.legacy.sourceStates?.managed?.reason, 'old managed source key');
        assert.equal((legacy.modules.legacy.sourceStates as any)?.data, undefined);
        assert.equal((legacy.modules.legacy.sourceStates as any)?.['built-in'], undefined);

        const store = createEmptyLifecycleStore();
        const created = upsertDiscoveredModule(store, {
            moduleId: 'shadowdark',
            title: 'Shadowdark RPG',
            directory: 'shadowdark'
        }, 1000);

        assert.equal(created.status, 'discovered');
        assert.equal(created.enabled, true);
        assert.equal(created.firstSeenAt, 1000);
        assert.equal(created.lastSeenAt, 1000);

        store.modules.shadowdark.status = 'disabled';
        store.modules.shadowdark.enabled = false;
        store.modules.shadowdark.activeSource = ModuleSourceCategory.Local;
        store.modules.shadowdark.localEnabled = true;

        const updated = upsertDiscoveredModule(store, {
            moduleId: 'shadowdark',
            title: 'Shadowdark RPG Updated',
            directory: 'shadowdark'
        }, 2000);

        assert.equal(updated.enabled, false);
        assert.equal(updated.status, 'disabled');
        assert.equal(updated.firstSeenAt, 1000);
        assert.equal(updated.lastSeenAt, 2000);
        assert.equal(updated.title, 'Shadowdark RPG Updated');

        // Runtime failures in a local development source remain warning-only;
        // explicit enablement is preserved so the developer can repair in place.
        store.modules.shadowdark.status = 'validated';
        store.modules.shadowdark.enabled = true;
        store.modules.shadowdark.localEnabled = true;
        store.modules.shadowdark.sourceStates = {
            [ModuleSourceCategory.Local]: {
                status: 'validated',
                enabled: true,
            },
        };

        const failed = recordLifecycleRuntimeFailure(
            store,
            'shadowdark',
            'Adapter initialize failed in test',
            3000
        );
        assert.ok(failed);
        assert.equal(failed?.status, 'validated');
        assert.equal(failed?.enabled, true);
        assert.equal(failed?.health?.errorCount, 1);
        assert.equal(failed?.health?.lastError, 'Adapter initialize failed in test');
        assert.equal(failed?.health?.lastErrorAt, 3000);
        assert.equal(failed?.localEnabled, true, 'runtime failure preserves local developer enablement');
        assert.equal(failed?.sourceStates?.local?.status, 'validated');
        assert.equal(failed?.sourceStates?.local?.enabled, true);
        assert.equal(failed?.sourceStates?.local?.health?.errorCount, 1);

        const failedAgain = recordLifecycleRuntimeFailure(
            store,
            'shadowdark',
            'Second adapter failure in test',
            4000
        );
        assert.ok(failedAgain);
        assert.equal(failedAgain?.health?.errorCount, 2);
        assert.equal(failedAgain?.health?.lastError, 'Second adapter failure in test');
        assert.equal(failedAgain?.health?.lastErrorAt, 4000);

        saveLifecycleStore(store, stateFilePath);
        const reloaded = loadLifecycleStore(stateFilePath);
        const records = getLifecycleRecords(reloaded);
        assert.equal(records.length, 1);
        assert.equal(records[0].moduleId, 'shadowdark');
        assert.equal(records[0].status, 'validated');
        assert.equal(records[0].enabled, true);
        assert.equal(records[0].title, 'Shadowdark RPG Updated');
        assert.equal(records[0].health?.errorCount, 2);
        assert.equal(records[0].health?.lastError, 'Second adapter failure in test');
        assert.equal(records[0].health?.lastErrorAt, 4000);
    } finally {
        if (fs.existsSync(stateFilePath)) {
            fs.unlinkSync(stateFilePath);
        }
        if (fs.existsSync(legacyStateFilePath)) {
            fs.unlinkSync(legacyStateFilePath);
        }
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        run();
        console.log('module-lifecycle-state.test.ts passed');
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}
