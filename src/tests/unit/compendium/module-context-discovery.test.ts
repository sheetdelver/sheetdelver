import { strict as assert } from 'node:assert';
import { CompendiumCache as NameCompendiumCache } from '@server/core/compendium/CompendiumCache';
import {
    DiscoveryShardStore,
    type DiscoveryShardCache,
} from '@server/core/compendium/DiscoveryShardStore';
import { createScopedDiscovery, type DiscoveryScope } from '@server/shared/utils/createModuleContext';

class MemoryShardCache implements DiscoveryShardCache {
    private readonly values = new Map<string, unknown>();

    public async get<T>(namespace: string, key: string): Promise<T | null> {
        return this.values.get(`${namespace}/${key}`) as T || null;
    }

    public async set<T>(namespace: string, key: string, value: T): Promise<void> {
        this.values.set(`${namespace}/${key}`, value);
    }
}

export async function run() {
    await runModuleScopedShardReads();
    await runFailClosedWithoutScope();
    await runScopedNameFallback();
    console.log('  - Module context discovery: all checks passed');
}

async function createSeededStore(): Promise<DiscoveryShardStore> {
    const store = new DiscoveryShardStore(new MemoryShardCache());
    await store.setManifest({
        systemId: 'synthetic-module',
        _instanceId: 'synthetic-instance',
        packs: {
            'synthetic.items': { id: 'synthetic.items', hash: 'items', lastUpdated: 1, rowCount: 1 },
            'synthetic.tables': { id: 'synthetic.tables', hash: 'tables', lastUpdated: 1, rowCount: 1 },
        },
    });
    await store.setShard('synthetic-module', 'synthetic.items', [
        {
            _id: 'torch',
            uuid: 'Compendium.synthetic.items.Item.torch',
            name: 'Torch',
            type: 'Gear',
        },
    ]);
    await store.setShard('synthetic-module', 'synthetic.tables', [
        {
            _id: 'talents',
            uuid: 'Compendium.synthetic.tables.RollTable.talents',
            name: 'Talents',
        },
    ]);
    return store;
}

function itemOnlyScope(): DiscoveryScope {
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

async function runModuleScopedShardReads() {
    const discovery = await createScopedDiscovery('synthetic-module', {
        shardStore: await createSeededStore(),
        getDiscoveryScope: () => itemOnlyScope(),
    });

    assert.equal((await discovery.findOne('Item', { name: 'Torch' }))?._id, 'torch');
    assert.equal((await discovery.getById('Item', 'torch'))?.name, 'Torch');
    assert.equal((await discovery.findAll('Item')).length, 1);
    assert.deepEqual(await discovery.findAll('RollTable'), []);
    assert.equal(await discovery.getById('RollTable', 'talents'), null);
}

async function runFailClosedWithoutScope() {
    const discovery = await createScopedDiscovery('missing-module', {
        shardStore: await createSeededStore(),
        getDiscoveryScope: () => null,
    });

    assert.deepEqual(await discovery.findAll('Item'), []);
    assert.equal(await discovery.findOne('Item', { name: 'Torch' }), null);
    assert.equal(await discovery.getById('Item', 'torch'), null);
}

async function runScopedNameFallback() {
    const nameCache = NameCompendiumCache.getInstance();
    nameCache.reset();
    nameCache.set('Compendium.synthetic.items.Item.cached', 'Cached Torch');
    nameCache.set('Compendium.other.items.Item.secret', 'Secret Item');

    const discovery = await createScopedDiscovery('synthetic-module', {
        shardStore: new DiscoveryShardStore(new MemoryShardCache()),
        getDiscoveryScope: () => itemOnlyScope(),
        getNameCache: () => nameCache,
    });

    assert.equal(
        (await discovery.getById('Item', 'Compendium.synthetic.items.Item.cached'))?.name,
        'Cached Torch',
    );
    assert.equal(await discovery.getById('Item', 'Compendium.other.items.Item.secret'), null);
    assert.equal(
        (await discovery.findOne('Item', { _id: 'Compendium.synthetic.items.Item.cached' }))?.name,
        'Cached Torch',
    );

    nameCache.reset();
}
