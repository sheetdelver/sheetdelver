import { strict as assert } from 'node:assert';
import {
    DiscoveryShardStore,
    type DiscoveryShardCache,
    type DiscoveryShardDocument,
} from '@server/core/compendium/DiscoveryShardStore';
import type { DiscoveryShardManifest } from '@server/core/compendium/types';

class MemoryShardCache implements DiscoveryShardCache {
    public readonly values = new Map<string, unknown>();

    public async get<T>(namespace: string, key: string): Promise<T | null> {
        return this.values.get(`${namespace}/${key}`) as T || null;
    }

    public async set<T>(namespace: string, key: string, value: T): Promise<void> {
        this.values.set(`${namespace}/${key}`, value);
    }
}

export async function run() {
    await runManifestAndShardRoundTrip();
    await runScopedQueries();
    await runLegacyShardKeyCompatibility();
    console.log('  - DiscoveryShardStore: all checks passed');
}

// Synthetic shard documents only. These mirror the small shape DiscoveryService
// persists without committing real compendium pack data.
function createManifest(): DiscoveryShardManifest {
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

function itemRows(): DiscoveryShardDocument[] {
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

async function runManifestAndShardRoundTrip() {
    const cache = new MemoryShardCache();
    const store = new DiscoveryShardStore(cache);
    const manifest = createManifest();

    await store.setManifest(manifest);
    await store.setShard('synthetic-system', 'synthetic.items', itemRows());

    assert.equal((await store.getManifest('synthetic-system'))?.packs['synthetic.items'].rowCount, 2);
    assert.equal((await store.getShard('synthetic-system', 'synthetic.items'))?.[0]?.name, 'Torch');
}

async function runScopedQueries() {
    const cache = new MemoryShardCache();
    const store = new DiscoveryShardStore(cache);

    await store.setManifest(createManifest());
    await store.setShard('synthetic-system', 'synthetic.items', itemRows());
    await store.setShard('synthetic-system', 'synthetic.tables', [
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

async function runLegacyShardKeyCompatibility() {
    const cache = new MemoryShardCache();
    const store = new DiscoveryShardStore(cache);

    await cache.set('synthetic-system', 'pack-synthetic-items.extra', [
        { _id: 'legacy', name: 'Legacy Key Row' },
    ]);

    assert.equal(
        (await store.getShard('synthetic-system', 'synthetic.items.extra'))?.[0]?.name,
        'Legacy Key Row',
    );
}
