import { strict as assert } from 'node:assert';
import { SettingStore, settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { modifyDocumentRouter } from '@server/core/documents/primary/base/modifyDocumentRouter';
import {
    DOCUMENT_VISIBILITY,
    FoundryUserRole,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';

const player: DocumentAccessSubject = { userId: 'p-1', role: FoundryUserRole.PLAYER };
const gm: DocumentAccessSubject = { userId: 'gm-1', role: FoundryUserRole.GAMEMASTER };

/**
 * SettingStore (ADR-0028 Phase 7, settings slice): raw world-config mirror
 * with GM-only visibility and the privileged `getValueByKey` accessor used by
 * internal consumers (combat skip-defeated).
 */
export async function run() {
    await runValueLookupAndParsing();
    await runRouterMaintainsSettings();
    await runGmOnlyVisibility();
    console.log('  - SettingStore: all checks passed');
}

async function runValueLookupAndParsing() {
    const store = new SettingStore();
    await store.seed(async () => [
        // Foundry persists setting values JSON-serialized.
        {
            _id: 'set-ctc',
            key: 'core.combatTrackerConfig',
            value: JSON.stringify({ resource: '', skipDefeated: true }),
        },
        // Defensive: already-parsed object values pass through.
        { _id: 'set-obj', key: 'core.someObject', value: { enabled: true } },
        // Non-JSON strings return as-is.
        { _id: 'set-plain', key: 'core.plain', value: 'not-json' },
    ]);

    assert.deepEqual(store.getValueByKey('core.combatTrackerConfig'), { resource: '', skipDefeated: true });
    assert.deepEqual(store.getValueByKey('core.someObject'), { enabled: true });
    assert.equal(store.getValueByKey('core.plain'), 'not-json');
    assert.equal(store.getValueByKey('core.missing'), undefined);
}

async function runRouterMaintainsSettings() {
    // The singleton is registered with the router — a world setting change in
    // Foundry lands as a Setting modifyDocument and updates the mirror.
    await settingStore.seed(async () => [
        {
            _id: 'set-ctc',
            key: 'core.combatTrackerConfig',
            value: JSON.stringify({ skipDefeated: false }),
        },
    ]);

    try {
        modifyDocumentRouter.route({
            type: 'Setting',
            action: 'update',
            result: [{ _id: 'set-ctc', value: JSON.stringify({ skipDefeated: true }) }],
        });
        assert.deepEqual(
            settingStore.getValueByKey('core.combatTrackerConfig'),
            { skipDefeated: true },
            'setting update flows through the router into the mirror',
        );

        // New settings arrive as creates.
        modifyDocumentRouter.route({
            type: 'Setting',
            action: 'create',
            result: [{ _id: 'set-new', key: 'core.newSetting', value: '"fresh"' }],
        });
        assert.equal(settingStore.getValueByKey('core.newSetting'), 'fresh');

        // Broadcast-shaped delete (ADR-0031) removes the setting.
        modifyDocumentRouter.route({
            type: 'Setting',
            action: 'delete',
            result: ['set-new'],
            operation: {},
        });
        assert.equal(settingStore.getValueByKey('core.newSetting'), undefined);
    } finally {
        settingStore.clear('setting-store-test');
    }
}

async function runGmOnlyVisibility() {
    const store = new SettingStore();
    await store.seed(async () => [
        { _id: 'set-1', key: 'core.theme', value: '"dark"' },
    ]);

    assert.equal(store.canReadDocument('set-1', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(store.canReadDocument('set-1', gm, DOCUMENT_VISIBILITY.WRITEABLE), true);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('setting-store.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
