import { strict as assert } from 'node:assert';
import { CompendiumStore } from '@server/core/compendium/CompendiumStore';
import type {
    CompendiumDiscoveryResult,
    CompendiumIndexEntry,
    CompendiumPackCache,
    CompendiumPackDocument,
    CompendiumPackManifest,
    CompendiumPackMetadata,
    GameDataPackEnvelope,
} from '@server/core/compendium/types';

class MemoryPackCache implements CompendiumPackCache {
    public readonly values = new Map<string, unknown>();

    public async get<T>(namespace: string, key: string): Promise<T | null> {
        return this.values.get(`${namespace}/${key}`) as T || null;
    }

    public async set<T>(namespace: string, key: string, value: T): Promise<void> {
        this.values.set(`${namespace}/${key}`, value);
    }
}

export async function run() {
    await runSeedAndAccessors();
    await runFieldAwareVariants();
    await runUuidLookup();
    await runCloneOnRead();
    await runCloneOnWrite();
    await runClearAndReplacementSemantics();
    await runSeedPackMetadataFromGameData();
    await runManifestAndPackRowRoundTrip();
    await runScopedQueries();
    await runFindDocument();
    await runLegacyPackKeyCompatibility();
    await runClearPreservesPersistentShards();
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

function createManifest(): CompendiumPackManifest {
    return {
        systemId: 'synthetic-system',
        _instanceId: 'synthetic-instance',
        packs: {
            'synthetic.items': {
                id: 'synthetic.items',
                hash: 'hash-items',
                lastUpdated: 1,
                rowCount: 2,
                hydrate: true,
            },
            'synthetic.tables': {
                id: 'synthetic.tables',
                hash: 'hash-tables',
                lastUpdated: 2,
                rowCount: 1,
                hydrate: false,
            },
        },
    };
}

function itemRows(): CompendiumPackDocument[] {
    return [
        {
            _id: 'torch',
            uuid: 'Compendium.synthetic.items.Item.torch',
            name: 'Torch',
            type: 'Gear',
            system: { tier: 1 },
        },
        {
            _id: 'spell',
            uuid: 'Compendium.synthetic.items.Item.spell',
            name: 'Spell',
            type: 'Spell',
            system: { tier: 2 },
        },
    ];
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

async function runSeedPackMetadataFromGameData() {
    const store = new CompendiumStore();
    const envelope: GameDataPackEnvelope = {
        packs: [
            {
                id: 'dnd5e.heroes',
                name: 'heroes',
                label: 'Starter Heroes',
                path: 'systems/dnd5e/packs/heroes',
                type: 'Actor',
                system: 'dnd5e',
                packageType: 'system',
                packageName: 'dnd5e',
            },
        ],
        system: {
            id: 'dnd5e',
            packs: [
                {
                    name: 'spells',
                    label: 'Spells',
                    type: 'Item',
                    packageName: 'dnd5e',
                },
            ],
        },
        modules: [
            {
                id: 'shadowdark',
                packs: [
                    {
                        id: 'shadowdark.gear',
                        name: 'gear',
                        label: 'Gear',
                        type: 'Item',
                    },
                ],
            },
        ],
    };

    store.seedPackMetadataFromGameData(envelope);

    assert.equal(store.hasPackMetadata('dnd5e.heroes'), true);
    assert.equal(store.hasPackMetadata('dnd5e.spells'), true);
    assert.equal(store.hasPackMetadata('shadowdark.gear'), true);

    const heroes = store.getPackMetadata('dnd5e.heroes');
    assert.equal(heroes?.type, 'Actor');
    assert.equal(heroes?.source, 'game.packs');

    const spells = store.getPackMetadata('dnd5e.spells');
    assert.equal(spells?.source, 'system');

    const gear = store.getPackMetadata('shadowdark.gear');
    assert.equal(gear?.source, 'module');
    assert.equal(gear?.moduleId, 'shadowdark');

    // Re-seeding the same id from a later source must not duplicate or replace
    // the first record's source attribution.
    assert.equal(store.listPackMetadata().length, 3);

    // Pre-filed metadata never carries index rows or documents.
    assert.equal(store.getPackIndex('dnd5e.heroes'), null);
    assert.equal(store.listPackIndices().length, 0);
}

async function runManifestAndPackRowRoundTrip() {
    const cache = new MemoryPackCache();
    const store = new CompendiumStore(cache);
    const manifest = createManifest();

    await store.setManifest(manifest);
    await store.setPackRows('synthetic-system', 'synthetic.items', itemRows());

    assert.equal((await store.getManifest('synthetic-system'))?.packs['synthetic.items'].rowCount, 2);
    assert.equal((await store.getPackRows('synthetic-system', 'synthetic.items'))?.[0]?.name, 'Torch');
}

async function runScopedQueries() {
    const cache = new MemoryPackCache();
    const store = new CompendiumStore(cache);

    await store.setManifest(createManifest());
    await store.setPackRows('synthetic-system', 'synthetic.items', itemRows());
    await store.setPackRows('synthetic-system', 'synthetic.tables', [
        { _id: 'talents', uuid: 'Compendium.synthetic.tables.RollTable.talents', name: 'Talents' },
    ]);

    const scopedItems = await store.findAll(
        'synthetic-system',
        'Item',
        { 'system.tier': 2 },
        { packIds: ['synthetic.items'] },
    );
    assert.equal(scopedItems.length, 1);
    assert.equal(scopedItems[0]._id, 'spell');

    const missingFromScope = await store.findAll(
        'synthetic-system',
        'RollTable',
        {},
        { packIds: ['synthetic.items'] },
    );
    assert.equal(missingFromScope.length, 2);

    assert.equal((await store.findOne('synthetic-system', 'Item', { name: 'Torch' }, { packIds: ['synthetic.items'] }))?._id, 'torch');
    assert.equal((await store.getById('synthetic-system', 'Item', 'spell', { packIds: ['synthetic.items'] }))?.name, 'Spell');
    assert.equal(await store.getById('synthetic-system', 'Item', 'missing', { packIds: ['synthetic.items'] }), null);
    assert.deepEqual(await store.findAll('synthetic-system', 'Item', {}, { packIds: [] }), []);
}

async function runFindDocument() {
    const cache = new MemoryPackCache();
    const store = new CompendiumStore(cache);

    await store.setPackRows('synthetic-system', 'synthetic.items', itemRows());

    assert.equal((await store.findDocument('synthetic-system', 'synthetic.items', 'torch', 'Item'))?.name, 'Torch');
    assert.equal((await store.findDocument('synthetic-system', 'synthetic.items', 'Compendium.synthetic.items.Item.spell'))?.name, 'Spell');
    assert.equal((await store.findDocument('synthetic-system', 'synthetic.items', 'spell', 'Item'))?.name, 'Spell');
    assert.equal(await store.findDocument('synthetic-system', 'synthetic.items', 'missing', 'Item'), null);
    assert.equal(await store.findDocument('synthetic-system', 'synthetic.missing', 'torch', 'Item'), null);
}

async function runLegacyPackKeyCompatibility() {
    const cache = new MemoryPackCache();
    const store = new CompendiumStore(cache);

    await cache.set('synthetic-system', 'pack-synthetic-items.extra', [
        { _id: 'legacy', name: 'Legacy Key Row' },
    ]);

    assert.equal(
        (await store.getPackRows('synthetic-system', 'synthetic.items.extra'))?.[0]?.name,
        'Legacy Key Row',
    );
}

// ADR-0021: clear(reason) must drop in-memory state only. Persistent shards
// belong to the warm cache and survive a transient disconnect or world close.
async function runClearPreservesPersistentShards() {
    const cache = new MemoryPackCache();
    const store = new CompendiumStore(cache);

    store.setPackMetadata('synthetic.items', { id: 'synthetic.items', type: 'Item' });
    await store.setManifest(createManifest());
    await store.setPackRows('synthetic-system', 'synthetic.items', itemRows());

    assert.equal(store.hasPackMetadata('synthetic.items'), true);
    assert.equal(cache.values.size, 2);

    store.clear('transient-disconnect');

    // In-memory wiped …
    assert.equal(store.hasPackMetadata('synthetic.items'), false);
    assert.equal(store.isReady(), false);

    // … but persistent shards untouched, ready to be reused on reconnect.
    assert.equal(cache.values.size, 2);
    assert.equal((await store.getManifest('synthetic-system'))?.packs['synthetic.items'].rowCount, 2);
    assert.equal((await store.getPackRows('synthetic-system', 'synthetic.items'))?.[0]?.name, 'Torch');
}
