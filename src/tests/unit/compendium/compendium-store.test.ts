import { strict as assert } from 'node:assert';
import { CompendiumStore } from '@server/core/compendium/CompendiumStore';
import type {
    CompendiumDiscoveryResult,
    CompendiumIndexEntry,
    CompendiumPackMetadata,
} from '@server/core/compendium/types';

export async function run() {
    await runSeedAndAccessors();
    await runFieldAwareVariants();
    await runUuidLookup();
    await runCloneOnRead();
    await runCloneOnWrite();
    await runClearAndReplacementSemantics();
    console.log('  - CompendiumStore: all checks passed');
}

// Keep these fixtures synthetic. Real compendium pack rows, pack dumps, and local
// PersistentCache contents are runtime evidence only; ADR-0015 documents the
// small example shapes these tests cover.
function createMetadata(overrides: Partial<CompendiumPackMetadata> = {}): CompendiumPackMetadata {
    return {
        id: 'shadowdark.items',
        name: 'items',
        label: 'Shadowdark Items',
        type: 'Item',
        packageName: 'shadowdark',
        source: 'module',
        moduleId: 'shadowdark',
        ...overrides,
    };
}

function createIndex(overrides: Partial<CompendiumIndexEntry>[] = []): CompendiumIndexEntry[] {
    const base: CompendiumIndexEntry[] = [
        {
            _id: 'torch',
            uuid: 'Compendium.shadowdark.items.Item.torch',
            name: 'Torch',
            type: 'Gear',
            img: 'icons/torch.webp',
        },
        {
            _id: 'wizard-spell',
            uuid: 'Compendium.shadowdark.items.Item.wizard-spell',
            name: 'Wizard Spell',
            type: 'Spell',
            img: 'icons/spell.webp',
            'system.class': 'Wizard',
            'system.tier': 1,
        },
    ];

    return base.map((entry, index) => ({ ...entry, ...(overrides[index] || {}) }));
}

async function runSeedAndAccessors() {
    const store = new CompendiumStore();
    const results: CompendiumDiscoveryResult[] = [
        {
            id: 'shadowdark.items',
            metadata: createMetadata(),
            index: createIndex(),
        },
        {
            id: 'shadowdark.tables',
            metadata: createMetadata({
                id: 'shadowdark.tables',
                name: 'tables',
                label: 'Shadowdark Tables',
                type: 'RollTable',
            }),
            index: [
                {
                    _id: 'talents',
                    uuid: 'Compendium.shadowdark.tables.RollTable.talents',
                    name: 'Talents',
                    type: 'RollTable',
                },
            ],
        },
    ];

    store.seedDiscoveredPacks(results);

    assert.equal(store.isReady(), true);
    assert.equal(store.getPackMetadata('shadowdark.items')?.label, 'Shadowdark Items');
    assert.equal(store.getPackIndex('shadowdark.items')?.length, 2);
    assert.equal(store.listPackIndices().length, 2);
}

async function runFieldAwareVariants() {
    const store = new CompendiumStore();
    store.setPackIndex('shadowdark.items', createMetadata(), createIndex());
    store.setPackIndex(
        'shadowdark.items',
        createMetadata({ label: 'Shadowdark Items With Spell Fields' }),
        [
            {
                _id: 'wizard-spell',
                name: 'Wizard Spell',
                type: 'Spell',
                'system.class': 'Wizard',
                'system.tier': 1,
            },
        ],
        { fields: ['system.tier', 'system.class'] },
    );

    assert.equal(store.getPackIndex('shadowdark.items')?.length, 2);
    assert.equal(store.getPackIndex('shadowdark.items', { fields: ['system.class', 'system.tier'] })?.length, 1);
    assert.equal(store.getPackIndex('shadowdark.items', { fields: ['system.class'] }), null);

    const variant = store.listPackIndices({ fields: ['system.tier', 'system.class'] })[0]?.variant;
    assert.deepEqual(variant?.fields, ['system.class', 'system.tier']);
    assert.equal(variant?.fieldKey, 'fields:system.class|system.tier');
}

async function runUuidLookup() {
    const store = new CompendiumStore();
    store.setPackIndex('shadowdark.items', createMetadata(), createIndex());

    const found = store.findIndexEntry('Compendium.shadowdark.items.Item.torch');
    assert.equal(found?.packId, 'shadowdark.items');
    assert.equal(found?.documentId, 'torch');
    assert.equal(found?.type, 'Item');
    assert.equal(found?.entry.name, 'Torch');

    const noType = store.findIndexEntry('Compendium.shadowdark.items.torch');
    assert.equal(noType?.entry.name, 'Torch');
    assert.equal(noType?.type, null);

    assert.equal(store.findIndexEntry('Actor.actor-1'), null);
    assert.equal(store.findIndexEntry('Compendium.shadowdark.items.Item.missing'), null);
}

async function runCloneOnRead() {
    const store = new CompendiumStore();
    store.setPackIndex('shadowdark.items', createMetadata(), createIndex());

    const metadata = store.getPackMetadata('shadowdark.items');
    assert.ok(metadata);
    metadata.label = 'Mutated Label';
    assert.equal(store.getPackMetadata('shadowdark.items')?.label, 'Shadowdark Items');

    const index = store.getPackIndex('shadowdark.items');
    assert.ok(index);
    index[0].name = 'Mutated Torch';
    assert.equal(store.getPackIndex('shadowdark.items')?.[0]?.name, 'Torch');

    const lookup = store.findIndexEntry('Compendium.shadowdark.items.Item.torch');
    assert.ok(lookup);
    lookup.entry.name = 'Mutated Lookup';
    assert.equal(store.findIndexEntry('Compendium.shadowdark.items.Item.torch')?.entry.name, 'Torch');
}

async function runCloneOnWrite() {
    const store = new CompendiumStore();
    const metadata = createMetadata();
    const index = createIndex();

    store.setPackIndex('shadowdark.items', metadata, index);

    metadata.label = 'Mutated Metadata Input';
    index[0].name = 'Mutated Index Input';

    assert.equal(store.getPackMetadata('shadowdark.items')?.label, 'Shadowdark Items');
    assert.equal(store.getPackIndex('shadowdark.items')?.[0]?.name, 'Torch');
}

async function runClearAndReplacementSemantics() {
    const store = new CompendiumStore();
    store.setPackIndex('shadowdark.items', createMetadata(), createIndex());
    assert.equal(store.isReady(), true);

    store.clear('test-clear');
    assert.equal(store.isReady(), false);
    assert.equal(store.getPackMetadata('shadowdark.items'), null);
    assert.equal(store.getPackIndex('shadowdark.items'), null);

    store.seedDiscoveredPacks([
        {
            id: 'shadowdark.tables',
            metadata: createMetadata({ id: 'shadowdark.tables', type: 'RollTable' }),
            index: [{ _id: 'talents', name: 'Talents', type: 'RollTable' }],
        },
    ]);

    assert.equal(store.getPackIndex('shadowdark.items'), null);
    assert.equal(store.getPackIndex('shadowdark.tables')?.[0]?.name, 'Talents');
}
