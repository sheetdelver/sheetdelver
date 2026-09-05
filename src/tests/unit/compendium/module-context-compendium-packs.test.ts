import { strict as assert } from 'node:assert';
import { CompendiumStore } from '@server/core/compendium/CompendiumStore';
import type { CompendiumPackCache } from '@server/core/compendium/types';
import { createScopedCompendiumPacks, type CompendiumPackScope } from '@server/shared/utils/createModuleRuntime';

class MemoryPackCache implements CompendiumPackCache {
    private readonly values = new Map<string, unknown>();

    public async get<T>(namespace: string, key: string): Promise<T | null> {
        return this.values.get(`${namespace}/${key}`) as T || null;
    }

    public async set<T>(namespace: string, key: string, value: T): Promise<void> {
        this.values.set(`${namespace}/${key}`, value);
    }
}

export async function run() {
    await runModuleScopedPackReads();
    await runUndeclaredButPresentPackReadableByUuid();
    await runFailClosedForOtherSystem();
    await runNoNameCacheFallback();
    console.log('  - Module context compendium packs: all checks passed');
}

async function createSeededStore(): Promise<CompendiumStore> {
    const store = new CompendiumStore(new MemoryPackCache());
    await store.setManifest({
        systemId: 'synthetic-module',
        _instanceId: 'synthetic-instance',
        packs: {
            'synthetic.items': { id: 'synthetic.items', hash: 'items', lastUpdated: 1, rowCount: 1 },
            'synthetic.tables': { id: 'synthetic.tables', hash: 'tables', lastUpdated: 1, rowCount: 1 },
        },
    });
    await store.setPackRows('synthetic-module', 'synthetic.items', [
        {
            _id: 'torch',
            uuid: 'Compendium.synthetic.items.Item.torch',
            name: 'Torch',
            type: 'Gear',
        },
    ]);
    await store.setPackRows('synthetic-module', 'synthetic.tables', [
        {
            _id: 'talents',
            uuid: 'Compendium.synthetic.tables.RollTable.talents',
            name: 'Talents',
        },
    ]);
    return store;
}

function itemOnlyScope(): CompendiumPackScope {
    return {
        systemId: 'synthetic-module',
        packs: [
            {
                id: 'synthetic.items',
                type: 'Item',
                hydrate: true,
            },
        ],
    };
}

async function runModuleScopedPackReads() {
    const compendiumPacks = await createScopedCompendiumPacks('synthetic-module', {
        packStore: await createSeededStore(),
        getCompendiumPackScope: () => itemOnlyScope(),
    });

    // Query reads stay type-scoped to declared packs (the reader's authoritative type map);
    // an undeclared type resolves to empty (type unknown to the reader, not an access denial).
    assert.equal((await compendiumPacks.findOne('Item', { name: 'Torch' }))?._id, 'torch');
    assert.equal((await compendiumPacks.getById('Item', 'torch'))?.name, 'Torch');
    assert.equal((await compendiumPacks.findAll('Item')).length, 1);
    assert.deepEqual(await compendiumPacks.findAll('RollTable'), []);
    assert.equal(await compendiumPacks.getById('RollTable', 'talents'), null);
}

// ADR-0027 decision 11: declaration is hydration intent, NOT an access gate. A
// fully-qualified UUID names its own pack, so an undeclared-but-present pack is readable
// by UUID even though the scope declared only the Item pack. An absent pack returns null
// (fail-closed, offline — no live Foundry fetch).
async function runUndeclaredButPresentPackReadableByUuid() {
    const compendiumPacks = await createScopedCompendiumPacks('synthetic-module', {
        packStore: await createSeededStore(),
        getCompendiumPackScope: () => itemOnlyScope(),
    });

    assert.equal(
        (await compendiumPacks.getById('RollTable', 'Compendium.synthetic.tables.RollTable.talents'))?.name,
        'Talents',
        'undeclared-but-present pack resolves via fully-qualified UUID',
    );
    assert.equal(
        await compendiumPacks.getById('RollTable', 'Compendium.synthetic.missing.RollTable.x'),
        null,
        'absent pack fails closed',
    );
}

// Cross-system isolation is preserved by the systemId namespace: a module reading under a
// different system id finds nothing present and fails closed (no live Foundry fetch).
async function runFailClosedForOtherSystem() {
    const compendiumPacks = await createScopedCompendiumPacks('missing-module', {
        packStore: await createSeededStore(),
        getCompendiumPackScope: () => null,
    });

    assert.deepEqual(await compendiumPacks.findAll('Item'), []);
    assert.equal(await compendiumPacks.findOne('Item', { name: 'Torch' }), null);
    assert.equal(await compendiumPacks.getById('Item', 'torch'), null);
}

async function runNoNameCacheFallback() {
    const compendiumPacks = await createScopedCompendiumPacks('synthetic-module', {
        packStore: new CompendiumStore(new MemoryPackCache()),
        getCompendiumPackScope: () => itemOnlyScope(),
    });

    assert.equal(await compendiumPacks.getById('Item', 'Compendium.synthetic.items.Item.cached'), null);
    assert.equal(await compendiumPacks.getById('Item', 'Compendium.other.items.Item.secret'), null);
    assert.equal(await compendiumPacks.findOne('Item', { _id: 'Compendium.synthetic.items.Item.cached' }), null);
}
