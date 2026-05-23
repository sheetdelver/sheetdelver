import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { CompendiumStore } from '@server/core/compendium/CompendiumStore';
import {
    CompendiumPackStore,
    type CompendiumPackCache,
    type CompendiumPackDocument,
} from '@server/core/compendium/CompendiumPackStore';
import type { CompendiumIndexEntry } from '@server/core/compendium/types';
import { CompendiumPackSyncService, type CompendiumPackIndexReader, type CompendiumPackSyncClient } from '@server/services/compendium';
import type { CompendiumPackConfig } from '@shared/sdk';

interface EntryCall {
    kind: 'getPackEntries';
    packId: string;
    options?: { index?: boolean; fields?: readonly string[] };
}

interface EmitCall {
    kind: 'emit';
    event: string;
    payloads: unknown[];
}

class MemoryPackCache implements CompendiumPackCache {
    private readonly values = new Map<string, unknown>();

    public async get<T>(namespace: string, key: string): Promise<T | null> {
        const cacheKey = `${namespace}/${key}`;
        return this.values.has(cacheKey) ? this.values.get(cacheKey) as T : null;
    }

    public async set<T>(namespace: string, key: string, value: T): Promise<void> {
        this.values.set(`${namespace}/${key}`, value);
    }
}

class FakePackClient implements CompendiumPackSyncClient, CompendiumPackIndexReader {
    public readonly calls: Array<EntryCall | EmitCall> = [];
    public entryHandler: (packId: string, options?: { index?: boolean; fields?: readonly string[] }) => unknown[] =
        () => { throw new Error('unexpected getPackEntries call'); };
    public emitHandler: (event: string, payloads: unknown[]) => unknown =
        () => ({ result: [] });

    public async getPackEntries(
        packId: string,
        options?: { index?: boolean; fields?: readonly string[] },
    ): Promise<unknown[]> {
        this.calls.push({ kind: 'getPackEntries', packId, options });
        return this.entryHandler(packId, options);
    }

    public async emitSocketEvent<T>(event: string, ...payloads: unknown[]): Promise<T> {
        this.calls.push({ kind: 'emit', event, payloads });
        return this.emitHandler(event, payloads) as T;
    }
}

export async function run() {
    await runCachedDefaultIndexSkipsFreshPackRows();
    await runFieldAwareVariantFetchesOnlyWhenPackRowsRefresh();
    await runManifestHashCompatibility();
    console.log('  - CompendiumPackSyncService: all checks passed');
}

// Synthetic rows only. These capture the id/name hash shape, default index
// shape, and projected-field variant shape without storing real pack data.
function defaultIndex(): CompendiumIndexEntry[] {
    return [
        {
            _id: 'torch',
            uuid: 'Compendium.synthetic.items.Item.torch',
            name: 'Torch',
            type: 'Item',
            img: 'icons/synthetic-torch.svg',
        },
    ];
}

function fieldAwareIndex(): CompendiumIndexEntry[] {
    return [
        {
            _id: 'torch',
            uuid: 'Compendium.synthetic.items.Item.torch',
            name: 'Torch',
            'system.tier': 1,
        },
    ];
}

function compendiumPackConfig(fields?: string[]): CompendiumPackConfig {
    return {
        packs: [
            {
                id: 'synthetic.items',
                type: 'Item',
                hydrate: false,
                ...(fields ? { fields } : {}),
            },
        ],
    };
}

function computeHash(entries: unknown[], hydrate: boolean): string {
    const signatureString = entries
        .map(entry => {
            if (!entry || typeof entry !== 'object') return '';
            const row = entry as { _id?: unknown; id?: unknown; name?: unknown };
            return `${row._id || row.id}-${row.name}`;
        })
        .concat(hydrate ? ['HYDRATED'] : ['INDEXED'])
        .sort()
        .join('|');
    return crypto.createHash('md5').update(signatureString).digest('hex');
}

function createStores(): { compendiumStore: CompendiumStore; packStore: CompendiumPackStore } {
    return {
        compendiumStore: new CompendiumStore(),
        packStore: new CompendiumPackStore(new MemoryPackCache()),
    };
}

async function runCachedDefaultIndexSkipsFreshPackRows() {
    const { compendiumStore, packStore } = createStores();
    const client = new FakePackClient();
    const rows = defaultIndex();

    compendiumStore.setPackIndex('synthetic.items', { id: 'synthetic.items', type: 'Item' }, rows);
    await packStore.setManifest({
        systemId: 'synthetic-system',
        _instanceId: 'synthetic-instance',
        packs: {
            'synthetic.items': {
                id: 'synthetic.items',
                hash: computeHash(rows, false),
                lastUpdated: 1,
                rowCount: 1,
                hydrate: false,
            },
        },
    });
    await packStore.setPackRows('synthetic-system', 'synthetic.items', rows as CompendiumPackDocument[]);

    const service = new CompendiumPackSyncService({ compendiumStore, packStore });
    const manifest = await service.sync(client, 'synthetic-system', compendiumPackConfig(), client);

    assert.equal(manifest.packs['synthetic.items'].hash, computeHash(rows, false));
    assert.equal(client.calls.length, 0);
}

async function runFieldAwareVariantFetchesOnlyWhenPackRowsRefresh() {
    const { compendiumStore, packStore } = createStores();
    const client = new FakePackClient();
    const rows = defaultIndex();
    const fieldRows = fieldAwareIndex();

    compendiumStore.setPackIndex('synthetic.items', { id: 'synthetic.items', type: 'Item' }, rows);
    client.entryHandler = (_packId, options) => {
        assert.deepEqual(options?.fields, ['name', 'system.tier']);
        return fieldRows;
    };

    const service = new CompendiumPackSyncService({ compendiumStore, packStore });
    await service.sync(client, 'synthetic-system', compendiumPackConfig(['system.tier', 'name']), client);

    const calls = client.calls.filter((call): call is EntryCall => call.kind === 'getPackEntries');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options?.fields, ['name', 'system.tier']);
    assert.equal(
        compendiumStore.getPackIndex('synthetic.items', { fields: ['system.tier', 'name'] })?.[0]?.['system.tier'],
        1,
    );
    assert.equal((await packStore.findDocument('synthetic-system', 'synthetic.items', 'torch'))?.['system.tier'], 1);
}

async function runManifestHashCompatibility() {
    const { compendiumStore, packStore } = createStores();
    const client = new FakePackClient();
    const rows = defaultIndex();

    compendiumStore.setPackIndex('synthetic.items', { id: 'synthetic.items', type: 'Item' }, rows);

    const service = new CompendiumPackSyncService({ compendiumStore, packStore });
    await service.sync(client, 'synthetic-system', compendiumPackConfig(), client);

    const manifest = await packStore.getManifest('synthetic-system');
    assert.equal(manifest?.packs['synthetic.items'].hash, computeHash(rows, false));
    assert.equal(client.calls.length, 0);
}
