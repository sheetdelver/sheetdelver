import { strict as assert } from 'node:assert';
import { SettingStore } from '@server/core/documents/primary/settings/SettingStore';
import { ModifyDocumentRouter } from '@server/core/documents/primary/base/modifyDocumentRouter';
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
    await runScopedRevisions();
    console.log('  - SettingStore: all checks passed');
}

async function runScopedRevisions() {
    const store = new SettingStore();
    const rows = [{ _id: 'rule', key: 'fixture.rule', value: 'false' },
        { _id: 'clock', key: 'core.time', value: '0' },
        { _id: 'personal', key: 'fixture.rule', value: 'false', user: 'p-1' }];
    await store.seed(async () => rows);
    const keys = ['fixture.rule'];
    const initial = store.getWorldKeysRevision(keys);
    store.patch('clock', { value: '1' });
    store.patch('personal', { value: 'true' });
    assert.equal(store.getWorldKeysRevision(keys), initial, 'unrelated and user-scoped rows do not retire world rules');
    store.patch('rule', { value: 'true' }); store.patch('rule', { value: 'false' });
    assert.notEqual(store.getWorldKeysRevision(keys), initial, 'relevant change-and-revert must retire a snapshot');
    let before = store.getWorldKeysRevision(keys);
    store.delete('rule'); assert.notEqual(store.getWorldKeysRevision(keys), before, 'deleted dependencies invalidate');
    before = store.getWorldKeysRevision(keys);
    store.upsert(rows[0]); assert.notEqual(store.getWorldKeysRevision(keys), before, 'created dependencies invalidate');
    before = store.getWorldKeysRevision(keys);
    store.patch('rule', { key: 'fixture.renamed' }); assert.notEqual(store.getWorldKeysRevision(keys), before, 'renaming invalidates the old key');
    before = store.getWorldKeysRevision(keys);
    store.patch('rule', { key: 'fixture.rule' }); assert.notEqual(store.getWorldKeysRevision(keys), before, 'renaming invalidates the new key');
    for (const invalidate of [() => store.observeMutation(), () => store.markStale('rule'), () => store.clear()]) {
        before = store.getWorldKeysRevision(keys); invalidate(); assert.notEqual(store.getWorldKeysRevision(keys), before);
    }
    const baseline = store.captureReconciliation();
    before = store.getWorldKeysRevision(keys); await store.seed(async () => rows);
    assert.notEqual(store.getWorldKeysRevision(keys), before, 'replacement invalidates existing scopes');
    before = store.getWorldKeysRevision(keys); store.publishReconciliation(baseline);
    assert.equal(store.getWorldKeysRevision(keys), before, 'publishing an already-seeded snapshot is not a new source mutation');
}

async function runValueLookupAndParsing() {
    const store = new SettingStore();
    await store.seed(async () => [
        // Foundry stores user- and world-scoped values in the same collection.
        // A privileged world-config lookup must not select a user's row merely
        // because that row appears first.
        {
            _id: 'set-user-ctc',
            key: 'core.combatTrackerConfig',
            value: JSON.stringify({ resource: 'user', skipDefeated: false }),
            user: 'p-1',
        },
        // Foundry persists setting values JSON-serialized.
        {
            _id: 'set-ctc',
            key: 'core.combatTrackerConfig',
            value: JSON.stringify({ resource: '', skipDefeated: true }),
            user: null,
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
    // Keep this fixture independent of coordinator import order while proving
    // that a Foundry Setting modifyDocument updates the registered mirror.
    const store = new SettingStore();
    const router = new ModifyDocumentRouter();
    router.register(store);
    await store.seed(async () => [
        {
            _id: 'set-ctc',
            key: 'core.combatTrackerConfig',
            value: JSON.stringify({ skipDefeated: false }),
        },
    ]);

    try {
        router.route({
            type: 'Setting',
            action: 'update',
            result: [{ _id: 'set-ctc', value: JSON.stringify({ skipDefeated: true }) }],
        });
        assert.deepEqual(
            store.getValueByKey('core.combatTrackerConfig'),
            { skipDefeated: true },
            'setting update flows through the router into the mirror',
        );

        // New settings arrive as creates.
        router.route({
            type: 'Setting',
            action: 'create',
            result: [{ _id: 'set-new', key: 'core.newSetting', value: '"fresh"' }],
        });
        assert.equal(store.getValueByKey('core.newSetting'), 'fresh');

        // Broadcast-shaped delete (ADR-0031) removes the setting.
        router.route({
            type: 'Setting',
            action: 'delete',
            result: ['set-new'],
            operation: {},
        });
        assert.equal(store.getValueByKey('core.newSetting'), undefined);
    } finally {
        store.clear('setting-store-test');
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
