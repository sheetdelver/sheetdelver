import { strict as assert } from 'node:assert';
import { CompendiumCache } from '@server/core/compendium/CompendiumCache';
import { CompendiumStore } from '@server/core/compendium/CompendiumStore';
import type { CompendiumIndexEntry } from '@server/core/compendium/types';
import type { GameData } from '@server/core/world/types';
import { CompendiumService, type CompendiumTransport } from '@server/services/compendium';

type EmitHandler = (event: string, payloads: unknown[]) => Promise<unknown> | unknown;
type DispatchHandler = (
    type: string,
    action: string,
    operation?: unknown,
    parent?: unknown,
    failHard?: boolean,
) => Promise<unknown> | unknown;

interface TransportCall {
    kind: 'emit' | 'dispatch';
    event?: string;
    type?: string;
    action?: string;
    payloads?: unknown[];
    operation?: unknown;
    failHard?: boolean;
}

class FakeCompendiumTransport implements CompendiumTransport {
    public isConnected = true;
    public calls: TransportCall[] = [];
    public heartbeatPauseCount = 0;
    public emitHandler: EmitHandler = () => ({ result: [] });
    public dispatchHandler: DispatchHandler = () => ({ result: [] });

    public async emitSocketEvent<T>(event: string, ...payloads: unknown[]): Promise<T> {
        this.calls.push({ kind: 'emit', event, payloads });
        return await this.emitHandler(event, payloads) as T;
    }

    public async dispatchDocumentSocket(
        type: string,
        action: string,
        operation?: unknown,
        parent?: unknown,
        failHard?: boolean,
    ): Promise<unknown> {
        void parent;
        this.calls.push({ kind: 'dispatch', type, action, operation, failHard });
        return this.dispatchHandler(type, action, operation, parent, failHard);
    }

    public async withHeartbeatPaused<T>(operation: () => Promise<T>): Promise<T> {
        this.heartbeatPauseCount += 1;
        return operation();
    }
}

export async function run() {
    await runDiscoveryDedupAndStoreWrites();
    await runPackEntriesFallbackAndHeartbeat();
    await runPackIndexDispatchFallback();
    await runPackDocumentsTypeFallback();
    await runPackDocumentModifyDocumentFallback();
    await runPackDocumentGetDocumentsFallback();
    await runPackDocumentDisconnected();
    await runCacheRebuildFromStore();
    console.log('  - CompendiumService: all checks passed');
}

// Keep these fixtures synthetic. They model the Foundry pack/index shapes the
// service consumes without checking in real world or compendium content.
function createGameData(): GameData {
    return {
        system: {
            id: 'synthetic-system',
            packs: [
                { name: 'system-tables', label: 'System Tables', type: 'RollTable' },
            ],
        },
        world: {
            id: 'synthetic-world',
            title: 'Synthetic World',
            packs: [
                { name: 'world-items', label: 'World Items', type: 'Item' },
            ],
        },
        modules: [
            {
                id: 'synthetic-module',
                title: 'Synthetic Module',
                packs: [
                    { name: 'module-items', label: 'Module Items', type: 'Item' },
                    { id: 'synthetic.items', name: 'duplicate-items', label: 'Duplicate Items', type: 'Item' },
                ],
            },
        ],
        packs: [
            { id: 'synthetic.items', name: 'items', label: 'Top-Level Items', type: 'Item' },
        ],
    };
}

function createIndex(packId: string, overrides: Partial<CompendiumIndexEntry> = {}): CompendiumIndexEntry[] {
    return [
        {
            _id: `${packId}-row`,
            uuid: `Compendium.${packId}.Item.${packId}-row`,
            name: `${packId} Row`,
            type: 'Item',
            ...overrides,
        },
    ];
}

async function runDiscoveryDedupAndStoreWrites() {
    const store = new CompendiumStore();
    const transport = new FakeCompendiumTransport();
    const service = new CompendiumService({
        transport,
        store,
        getGameDataSnapshot: () => createGameData(),
    });

    transport.emitHandler = (event, payloads) => {
        assert.equal(event, 'getCompendiumIndex');
        const packId = String(payloads[0]);
        return { result: createIndex(packId) };
    };

    const results = await service.discoverIndices();

    assert.equal(results.length, 4);
    assert.equal(transport.calls.length, 4);
    assert.deepEqual(results.map(result => result.id), [
        'synthetic.items',
        'synthetic-system.world-items',
        'synthetic-system.system-tables',
        'synthetic-module.module-items',
    ]);
    assert.equal(store.getPackIndex('synthetic.items')?.[0]?.name, 'synthetic.items Row');

    const cached = await service.discoverIndices();
    assert.equal(cached.length, 4);
    assert.equal(transport.calls.length, 4);
}

async function runPackEntriesFallbackAndHeartbeat() {
    const store = new CompendiumStore();
    const transport = new FakeCompendiumTransport();
    const service = new CompendiumService({ transport, store });

    transport.emitHandler = (event) => {
        if (event === 'modifyDocument') throw new Error('synthetic modify miss');
        if (event === 'getDocuments') {
            return { result: createIndex('synthetic.items', { 'system.tier': 1 }) };
        }
        throw new Error(`unexpected event ${event}`);
    };

    const rows = await service.getPackEntries('synthetic.items', { fields: ['system.tier'] });

    assert.equal(rows.length, 1);
    assert.equal(transport.heartbeatPauseCount, 1);
    assert.deepEqual(transport.calls.map(call => call.event).filter(Boolean), ['modifyDocument', 'getDocuments']);
    assert.equal(store.getPackIndex('synthetic.items', { fields: ['system.tier'] })?.[0]?.name, 'synthetic.items Row');
}

async function runPackIndexDispatchFallback() {
    const store = new CompendiumStore();
    const transport = new FakeCompendiumTransport();
    const service = new CompendiumService({ transport, store });

    transport.emitHandler = () => {
        throw new Error('synthetic socket miss');
    };
    transport.dispatchHandler = (_type, _action, _operation, _parent, failHard) => {
        assert.equal(failHard, false);
        return { result: createIndex('synthetic.tables', { type: 'RollTable' }) };
    };

    const rows = await service.getPackIndex('synthetic.tables', 'RollTable');

    assert.equal(rows.length, 1);
    assert.equal(transport.calls.at(-1)?.kind, 'dispatch');
    assert.equal(store.getPackIndex('synthetic.tables')?.[0]?.name, 'synthetic.tables Row');
}

async function runPackDocumentsTypeFallback() {
    const transport = new FakeCompendiumTransport();
    const service = new CompendiumService({ transport, store: new CompendiumStore() });

    transport.emitHandler = (_event, payloads) => {
        const payload = payloads[0] as { type?: string };
        if (payload.type === 'JournalEntry') throw new Error('synthetic singular miss');
        if (payload.type === 'JournalEntries') {
            return { result: [{ _id: 'journal-doc', name: 'Journal Doc' }] };
        }
        throw new Error(`unexpected type ${payload.type}`);
    };

    const docs = await service.getPackDocuments('synthetic.journals', 'JournalEntry');

    assert.equal(docs.length, 1);
    assert.deepEqual(transport.calls.map(call => (call.payloads?.[0] as { type?: string })?.type), [
        'JournalEntry',
        'JournalEntries',
    ]);
}

async function runPackDocumentModifyDocumentFallback() {
    const transport = new FakeCompendiumTransport();
    const service = new CompendiumService({ transport, store: new CompendiumStore() });

    transport.emitHandler = (event, payloads) => {
        assert.equal(event, 'modifyDocument');
        const payload = payloads[0] as { type?: string; operation?: { pack?: string; ids?: string[] } };
        assert.equal(payload.type, 'Item');
        assert.equal(payload.operation?.pack, 'synthetic.items');
        assert.deepEqual(payload.operation?.ids, ['torch']);
        return { result: [{ _id: 'torch', uuid: 'Compendium.synthetic.items.Item.torch', name: 'Torch' }] };
    };

    const doc = await service.getPackDocument('synthetic.items', 'torch', 'Item');

    assert.equal(doc?.name, 'Torch');
    assert.deepEqual(transport.calls.map(call => call.event), ['modifyDocument']);
}

async function runPackDocumentGetDocumentsFallback() {
    const transport = new FakeCompendiumTransport();
    const service = new CompendiumService({ transport, store: new CompendiumStore() });

    transport.emitHandler = (event) => {
        if (event === 'modifyDocument') throw new Error('synthetic modify miss');
        if (event === 'getDocuments') {
            return { result: [{ _id: 'torch', uuid: 'Compendium.synthetic.items.Item.torch', name: 'Torch' }] };
        }
        throw new Error(`unexpected event ${event}`);
    };

    const doc = await service.getPackDocument('synthetic.items', 'torch', 'Item');

    assert.equal(doc?.name, 'Torch');
    assert.deepEqual(transport.calls.map(call => call.event), ['modifyDocument', 'getDocuments']);
}

async function runPackDocumentDisconnected() {
    const transport = new FakeCompendiumTransport();
    const service = new CompendiumService({ transport, store: new CompendiumStore() });
    transport.isConnected = false;

    assert.equal(await service.getPackDocument('synthetic.items', 'torch', 'Item'), null);
    assert.equal(transport.calls.length, 0);
}

async function runCacheRebuildFromStore() {
    const store = new CompendiumStore();
    const cache = CompendiumCache.getInstance();
    cache.reset();

    store.setPackIndex('synthetic.items', { id: 'synthetic.items', type: 'Item' }, createIndex('synthetic.items'));
    cache.rebuildFromStore(store);

    assert.equal(cache.hasLoaded(), true);
    assert.equal(cache.getName('Compendium.synthetic.items.Item.synthetic.items-row'), 'synthetic.items Row');
    cache.reset();
}
