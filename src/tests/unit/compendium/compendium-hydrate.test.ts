import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { CompendiumStore } from '@server/core/compendium/CompendiumStore';
import type {
    CompendiumIndexEntry,
    CompendiumPackCache,
    CompendiumPackDocument,
} from '@server/core/compendium/types';
import { CompendiumService, type CompendiumTransport } from '@server/services/compendium';
import type { CompendiumPackConfig } from '@shared/sdk';

interface EmitCall {
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

class FakeTransport implements CompendiumTransport {
    public isConnected = true;
    public readonly calls: EmitCall[] = [];
    public handler: (event: string, payloads: unknown[]) => unknown = () => ({ result: [] });

    public async emitSocketEvent<T>(event: string, ...payloads: unknown[]): Promise<T> {
        this.calls.push({ event, payloads });
        return this.handler(event, payloads) as T;
    }

    public async dispatchDocumentSocket(): Promise<unknown> {
        return null;
    }
}

export async function run() {
    await runFreshPersistentManifestSkipsTransport();
    await runFieldAwareVariantFetchesOnlyWhenPackRowsRefresh();
    await runDeclaredButAbsentPackIsSkippedWithoutTransport();
    await runHydrateFullDocumentsWhenStaleOrMissing();
    console.log('  - CompendiumService.hydratePacks: all checks passed');
}

function packMetadata(packId: string) {
    return {
        id: packId,
        name: packId.split('.')[1] || packId,
        label: 'Synthetic Pack',
        type: 'Item',
        packageName: 'synthetic',
    };
}

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

function createStore(): CompendiumStore {
    return new CompendiumStore(new MemoryPackCache());
}

// Per ADR-0021: a fresh persistent manifest plus on-disk rows means zero
// transport calls. The cache is authoritative across restarts.
async function runFreshPersistentManifestSkipsTransport() {
    const store = createStore();
    const transport = new FakeTransport();
    const rows = defaultIndex();

    store.setPackMetadata('synthetic.items', packMetadata('synthetic.items'));
    store.setPackIndex('synthetic.items', packMetadata('synthetic.items'), rows);
    await store.setManifest({
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
    await store.setPackRows('synthetic-system', 'synthetic.items', rows as CompendiumPackDocument[]);

    const service = new CompendiumService({ transport, store });
    const result = await service.hydratePacks('synthetic-system', compendiumPackConfig());

    assert.equal(result.skipped, 1);
    assert.equal(result.hydrated, 0);
    assert.equal(result.missing, 0);
    assert.equal(transport.calls.length, 0);
}

async function runFieldAwareVariantFetchesOnlyWhenPackRowsRefresh() {
    const store = createStore();
    const transport = new FakeTransport();
    const rows = defaultIndex();
    const fieldRows = fieldAwareIndex();

    store.setPackMetadata('synthetic.items', packMetadata('synthetic.items'));
    store.setPackIndex('synthetic.items', packMetadata('synthetic.items'), rows);

    transport.handler = (event, payloads) => {
        const op = (payloads[0] as { operation?: { fields?: readonly string[]; pack?: string } } | undefined)?.operation;
        if (event === 'modifyDocument' && op?.pack === 'synthetic.items' && Array.isArray(op.fields) && op.fields.length > 0) {
            return { result: fieldRows };
        }
        return { result: [] };
    };

    const service = new CompendiumService({ transport, store });
    await service.hydratePacks('synthetic-system', compendiumPackConfig(['system.tier', 'name']));

    // Field-aware fetch happened once.
    const fieldFetches = transport.calls.filter(call => {
        const op = (call.payloads[0] as { operation?: { fields?: readonly string[] } } | undefined)?.operation;
        return Array.isArray(op?.fields) && op!.fields!.length > 0;
    });
    assert.equal(fieldFetches.length, 1);

    assert.equal(
        store.getPackIndex('synthetic.items', { fields: ['system.tier', 'name'] })?.[0]?.['system.tier'],
        1,
    );
    assert.equal((await store.findDocument('synthetic-system', 'synthetic.items', 'torch'))?.['system.tier'], 1);
}

// Per ADR-0021 declared-but-absent policy: a module declares a pack that
// isn't in game.data.packs. The service logs and skips with no transport.
async function runDeclaredButAbsentPackIsSkippedWithoutTransport() {
    const store = createStore();
    const transport = new FakeTransport();
    // No setPackMetadata for 'synthetic.items' — the pack is absent.

    const service = new CompendiumService({ transport, store });
    const result = await service.hydratePacks('synthetic-system', compendiumPackConfig());

    assert.equal(result.missing, 1);
    assert.equal(result.hydrated, 0);
    assert.equal(result.skipped, 0);
    assert.equal(transport.calls.length, 0);
    assert.equal(await store.getManifest('synthetic-system'), null);
}

async function runHydrateFullDocumentsWhenStaleOrMissing() {
    const store = createStore();
    const transport = new FakeTransport();
    const index = defaultIndex();
    const fullDoc = { _id: 'torch', name: 'Torch', type: 'Item', system: { weight: 1 } };

    store.setPackMetadata('synthetic.items', packMetadata('synthetic.items'));

    transport.handler = (event, payloads) => {
        if (event === 'modifyDocument') {
            const op = (payloads[0] as { operation?: { pack?: string; index?: boolean; ids?: string[] } } | undefined)?.operation;
            if (op?.pack === 'synthetic.items') {
                if (op.index === false && Array.isArray(op.ids)) return { result: [fullDoc] };
                return { result: index };
            }
        }
        return { result: [] };
    };

    const service = new CompendiumService({
        transport,
        store,
    });

    const result = await service.hydratePacks('synthetic-system', {
        packs: [{ id: 'synthetic.items', type: 'Item', hydrate: true }],
    });

    assert.equal(result.hydrated, 1);
    assert.equal(result.missing, 0);
    assert.equal(result.skipped, 0);

    const manifest = await store.getManifest('synthetic-system');
    assert.equal(manifest?.packs['synthetic.items'].hydrate, true);
    assert.equal((await store.getPackRows('synthetic-system', 'synthetic.items'))?.[0]?.name, 'Torch');
}
