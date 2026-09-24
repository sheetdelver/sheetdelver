import { strict as assert } from 'node:assert';
import { CompendiumStore } from '@server/core/compendium/CompendiumStore';
import type { CompendiumIndexEntry } from '@server/core/compendium/types';
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
    await runPackEntriesFallbackAndHeartbeat();
    await runPackIndexDispatchFallback();
    await runPackIndexProjectedDispatchFallback();
    await runPackDocumentsTypeFallback();
    await runPackDocumentModifyDocumentFallback();
    await runPackDocumentGetDocumentsFallback();
    await runPackDocumentDisconnected();
    await runIndexProjectionRejectsUnprojectedFallback();
    console.log('  - CompendiumService: all checks passed');
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
    const fallback = transport.calls[1].payloads?.[1] as { query?: unknown; indexFields?: string[] };
    assert.deepEqual(fallback.query, {});
    assert.deepEqual(fallback.indexFields, ['_id', 'img', 'name', 'system.tier', 'type']);
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

async function runPackIndexProjectedDispatchFallback() {
    const store = new CompendiumStore();
    const transport = new FakeCompendiumTransport();
    const service = new CompendiumService({ transport, store });
    transport.emitHandler = (event) => {
        if (event === 'getCompendiumIndex') return { result: createIndex('synthetic.tables') };
        throw new Error('synthetic legacy event miss');
    };
    transport.dispatchHandler = (_type, _action, operation) => {
        assert.deepEqual(operation, {
            pack: 'synthetic.tables', index: true, query: {}, broadcast: false,
            indexFields: ['_id', 'img', 'name', 'system.tier', 'type'],
        });
        return { result: createIndex('synthetic.tables', { 'system.tier': 3 }) };
    };
    const rows = await service.getPackIndex('synthetic.tables', 'RollTable', { fields: ['system.tier'] });
    assert.equal(rows[0]?.['system.tier'], 3);
    assert.equal(store.getPackIndex('synthetic.tables', { fields: ['system.tier'] })?.[0]?.['system.tier'], 3);
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
        const payload = payloads[0] as { type?: string; operation?: { pack?: string; query?: { _id?: string } } };
        assert.equal(payload.type, 'Item');
        assert.equal(payload.operation?.pack, 'synthetic.items');
        assert.deepEqual(payload.operation?.query, { _id: 'torch' });
        return { result: [{ _id: 'torch', uuid: 'Compendium.synthetic.items.Item.torch', name: 'Torch' }] };
    };

    const doc = await service.getPackDocument('synthetic.items', 'torch', 'Item');

    assert.equal(doc?.name, 'Torch');
    assert.deepEqual(transport.calls.map(call => call.event), ['modifyDocument']);
}

async function runPackDocumentGetDocumentsFallback() {
    const transport = new FakeCompendiumTransport();
    const service = new CompendiumService({ transport, store: new CompendiumStore() });

    transport.emitHandler = (event, payloads) => {
        if (event === 'modifyDocument') throw new Error('synthetic modify miss');
        if (event === 'getDocuments') {
            assert.deepEqual((payloads[0] as { operation?: unknown }).operation, {
                pack: 'synthetic.items', query: { _id: 'torch' },
            });
            return { result: [{ _id: 'torch', uuid: 'Compendium.synthetic.items.Item.torch', name: 'Torch' }] };
        }
        throw new Error(`unexpected event ${event}`);
    };

    const doc = await service.getPackDocument('synthetic.items', 'torch', 'Item');

    assert.equal(doc?.name, 'Torch');
    assert.deepEqual(transport.calls.map(call => call.event), ['modifyDocument', 'getDocuments']);
}

async function runIndexProjectionRejectsUnprojectedFallback() {
    const store = new CompendiumStore();
    const transport = new FakeCompendiumTransport();
    const service = new CompendiumService({ transport, store });
    transport.emitHandler = (event, payloads) => {
        if (event === 'modifyDocument') {
            const operation = (payloads[0] as { operation: Record<string, unknown> }).operation;
            assert.deepEqual(operation.query, {});
            assert.deepEqual(operation.indexFields, ['_id', 'img', 'name', 'system.tier', 'type']);
            return { result: createIndex('synthetic.items', { 'system.tier': 2 }) };
        }
        throw new Error(`unexpected fallback ${event}`);
    };
    const rows = await service.getPackEntries('synthetic.items', { fields: ['system.tier'] });
    assert.equal(rows.length, 1);
    assert.equal(store.getPackIndex('synthetic.items', { fields: ['system.tier'] })?.[0]?.['system.tier'], 2);

    const missingFieldTransport = new FakeCompendiumTransport();
    const missingFieldStore = new CompendiumStore();
    const missingFieldService = new CompendiumService({ transport: missingFieldTransport, store: missingFieldStore });
    missingFieldTransport.emitHandler = () => ({ result: createIndex('synthetic.items') });
    assert.deepEqual(await missingFieldService.getPackEntries('synthetic.items', { fields: ['system.tier'] }), []);
    assert.equal(missingFieldStore.getPackIndex('synthetic.items', { fields: ['system.tier'] }), null);

    const noIdentityTransport = new FakeCompendiumTransport();
    const noIdentityStore = new CompendiumStore();
    const noIdentityService = new CompendiumService({ transport: noIdentityTransport, store: noIdentityStore });
    noIdentityTransport.emitHandler = () => ({ result: [{ name: 'Nameless ID', 'system.tier': 1 }] });
    assert.deepEqual(await noIdentityService.getPackEntries('synthetic.items', { fields: ['system.tier'] }), []);
    assert.equal(noIdentityStore.getPackIndex('synthetic.items', { fields: ['system.tier'] }), null);
}

async function runPackDocumentDisconnected() {
    const transport = new FakeCompendiumTransport();
    const service = new CompendiumService({ transport, store: new CompendiumStore() });
    transport.isConnected = false;

    assert.equal(await service.getPackDocument('synthetic.items', 'torch', 'Item'), null);
    assert.equal(transport.calls.length, 0);
}
