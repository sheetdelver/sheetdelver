import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    createEmptyLifecycleStore,
    getLifecycleRecords,
    loadLifecycleStore,
    recordLifecycleRuntimeFailure,
    saveLifecycleStore,
    upsertDiscoveredModule,
} from '@modules/registry/lifecycle';

function mkTempStateFilePath() {
    return path.join(os.tmpdir(), `sheet-delver-lifecycle-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

export function run() {
    const stateFilePath = mkTempStateFilePath();

    try {
        const initial = loadLifecycleStore(stateFilePath);
        assert.equal(initial.version, 1);
        assert.equal(Object.keys(initial.modules).length, 0);

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

        const failed = recordLifecycleRuntimeFailure(
            store,
            'shadowdark',
            'Adapter initialize failed in test',
            3000
        );
        assert.ok(failed);
        assert.equal(failed?.status, 'errored');
        assert.equal(failed?.enabled, false);
        assert.equal(failed?.health?.errorCount, 1);
        assert.equal(failed?.health?.lastError, 'Adapter initialize failed in test');
        assert.equal(failed?.health?.lastErrorAt, 3000);

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
        assert.equal(records[0].status, 'errored');
        assert.equal(records[0].enabled, false);
        assert.equal(records[0].title, 'Shadowdark RPG Updated');
        assert.equal(records[0].health?.errorCount, 2);
        assert.equal(records[0].health?.lastError, 'Second adapter failure in test');
        assert.equal(records[0].health?.lastErrorAt, 4000);
    } finally {
        if (fs.existsSync(stateFilePath)) {
            fs.unlinkSync(stateFilePath);
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
