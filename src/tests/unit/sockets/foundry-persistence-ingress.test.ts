import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { FoundryEventIngress } from '@server/services/world/FoundryEventIngress';
import type { DocumentRepairUnavailableEvent } from '@server/services/world/FoundryEventIngress';
import {
    autosaveFixtures,
    manageCompendiumFixtures,
    terseAcknowledgementFixture,
    v13SingleUpdateFixture,
    v14BatchFixture,
} from '../fixtures/foundry-document-persistence';

type RoutedDocument = {
    type: string;
    action: string;
    result?: unknown;
    operation?: Record<string, unknown>;
};

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(res => {
        resolve = res;
    });
    return { promise, resolve };
}

class TestTransport extends EventEmitter {
    public calls: Array<{ event: string; payloads: unknown[] }> = [];
    public responses: Array<Promise<unknown>> = [];

    public async emitSocketEvent<T>(event: string, ...payloads: unknown[]): Promise<T> {
        this.calls.push({ event, payloads });
        const response = this.responses.shift();
        if (!response) throw new Error('No synthetic transport response queued');
        return await response as T;
    }
}

function createHarness() {
    const routed: RoutedDocument[] = [];
    const invalidated: Array<{ systemId: string | null | undefined; packId: string; reason?: string }> = [];
    const removed: Array<{ systemId: string | null | undefined; packId: string; reason?: string }> = [];
    const metadata = new Map<string, Record<string, unknown>>();
    const transport = new TestTransport();
    const ingress = new FoundryEventIngress({
        routeDocument: (payload) => {
            routed.push(payload);
        },
        compendiumStore: {
            setPackMetadata(packId, value) {
                metadata.set(packId, value);
            },
            async invalidatePackContent(systemId, packId, reason) {
                invalidated.push({ systemId, packId, reason });
            },
            async removePack(systemId, packId, reason) {
                metadata.delete(packId);
                removed.push({ systemId, packId, reason });
            },
        },
        getActiveSystemId: () => 'synthetic',
    });
    const detach = ingress.attach(transport);

    return { transport, routed, invalidated, removed, metadata, detach };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempts = 0; attempts < 20; attempts++) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Timed out waiting for asynchronous ingress work');
}

async function runSingleAndBatchRouting() {
    const harness = createHarness();
    try {
        harness.transport.emit('foundry:modifyDocument', { response: v13SingleUpdateFixture });
        harness.transport.emit('foundry:documentDispatchConfirmed', {
            response: terseAcknowledgementFixture,
            fallback: {
                type: 'JournalEntry',
                action: 'update',
                operation: { updates: [{ _id: 'journal-1' }] },
            },
        });
        harness.transport.emit('foundry:modifyDocumentBatch', { response: v14BatchFixture });
        await waitFor(() => harness.invalidated.length === 1);

        // The failed fourth batch entry is excluded, while the first two
        // successful world entries retain their original wire order.
        assert.deepEqual(
            harness.routed.map(entry => [entry.type, entry.action]),
            [
                ['Actor', 'update'],
                ['JournalEntry', 'update'],
                ['Actor', 'update'],
                ['ActiveEffect', 'create'],
            ],
        );
        assert.equal(harness.invalidated[0].packId, 'synthetic.items');
        assert.equal(harness.invalidated[0].reason, 'broadcast-batch:update');

        harness.transport.emit('foundry:documentDispatchConfirmed', {
            response: {
                type: 'Item',
                action: 'get',
                operation: { pack: 'synthetic.items' },
                result: [{ _id: 'item-1' }],
            },
        });
        assert.equal(harness.invalidated.length, 1, 'pack reads do not invalidate hydrated content');
        assert.equal(harness.routed.length, 4, 'pack reads never enter world Stores');
    } finally {
        harness.detach();
    }
}

async function runAutosaveRootRefresh() {
    const harness = createHarness();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    harness.transport.responses.push(first.promise, second.promise);

    try {
        harness.transport.emit('foundry:pmAutosave', autosaveFixtures.direct);
        harness.transport.emit('foundry:pmAutosave', autosaveFixtures.direct);
        assert.equal(harness.transport.calls.length, 1, 'concurrent autosaves share the active read');

        first.resolve({
            type: 'Actor',
            action: 'get',
            operation: { ids: ['actor-1'], broadcast: false },
            result: [{ _id: 'actor-1', name: 'First authoritative value' }],
        });
        await waitFor(() => harness.transport.calls.length === 2);

        second.resolve({
            type: 'Actor',
            action: 'get',
            operation: { ids: ['actor-1'], broadcast: false },
            result: [{ _id: 'actor-1', name: 'Trailing authoritative value' }],
        });
        await waitFor(() => harness.routed.length === 2);

        assert.ok(harness.transport.calls.every(call => call.event === 'modifyDocument'));
        assert.deepEqual(
            harness.routed.map(entry => [entry.type, entry.action]),
            [['Actor', 'update'], ['Actor', 'update']],
        );
        assert.deepEqual(
            harness.routed[1].result,
            [{ _id: 'actor-1', name: 'Trailing authoritative value' }],
        );
    } finally {
        harness.detach();
    }
}

async function runAutosaveScopeAndUuidRouting() {
    const harness = createHarness();
    const embeddedResponse = Promise.resolve({
        type: 'JournalEntry',
        action: 'get',
        result: [{ _id: 'journal-1', name: 'Refreshed parent' }],
    });
    harness.transport.responses.push(embeddedResponse);

    try {
        harness.transport.emit('foundry:pmAutosave', autosaveFixtures.embedded);
        await waitFor(() => harness.routed.length === 1);
        const request = harness.transport.calls[0].payloads[0] as {
            type: string;
            operation: { ids: string[] };
        };
        assert.equal(request.type, 'JournalEntry');
        assert.deepEqual(request.operation.ids, ['journal-1']);

        harness.transport.emit('foundry:pmAutosave', autosaveFixtures.compendium);
        await waitFor(() => harness.invalidated.length === 1);
        assert.equal(harness.invalidated[0].packId, 'synthetic.items');
        assert.equal(harness.invalidated[0].reason, 'pm.autosave');

        harness.transport.emit('foundry:pmAutosave', autosaveFixtures.malformed);
        assert.equal(harness.transport.calls.length, 1, 'malformed UUIDs do not issue reads');
    } finally {
        harness.detach();
    }
}

async function runStaleAutosaveRefreshIsDiscarded() {
    let runtimeEpoch = 4;
    const harness = createHarness();
    harness.detach();
    const response = deferred<unknown>();
    harness.transport.responses.push(response.promise);
    const ingress = new FoundryEventIngress({
        routeDocument: (payload) => {
            harness.routed.push(payload);
        },
        compendiumStore: {
            setPackMetadata: () => undefined,
            invalidatePackContent: async () => undefined,
            removePack: async () => undefined,
        },
        getActiveSystemId: () => 'synthetic',
        getRuntimeEpoch: () => runtimeEpoch,
    });
    const detach = ingress.attach(harness.transport);

    try {
        harness.transport.emit('foundry:pmAutosave', autosaveFixtures.direct);
        assert.equal(harness.transport.calls.length, 1);

        // Simulate world teardown while the authoritative root read is pending.
        runtimeEpoch += 1;
        response.resolve({
            type: 'Actor',
            action: 'get',
            result: [{ _id: 'actor-1', name: 'Departed world value' }],
        });
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(harness.routed.length, 0);
    } finally {
        detach();
    }
}

async function runRuntimeTeardownDelegation() {
    const reasons: string[] = [];
    const transport = new TestTransport();
    const ingress = new FoundryEventIngress({
        teardownWorldRuntime: (reason) => {
            reasons.push(reason);
        },
    });
    const detach = ingress.attach(transport);

    try {
        transport.emit('foundry:runtimeTeardown', { reason: 'world-a-departed' });
        transport.emit('foundry:runtimeTeardown', {});
        assert.deepEqual(reasons, ['world-a-departed', 'foundry-runtime-teardown']);
    } finally {
        detach();
    }
}

async function runStoreMissRepair() {
    const routed: RoutedDocument[] = [];
    const unavailable: DocumentRepairUnavailableEvent[] = [];
    const transport = new TestTransport();
    const firstRepair = deferred<unknown>();
    const trailingRepair = deferred<unknown>();
    transport.responses.push(firstRepair.promise, trailingRepair.promise);

    const ingress = new FoundryEventIngress({
        routeDocument: (payload) => {
            routed.push(payload);
            if (payload.type === 'Actor' && payload.action === 'update') {
                return {
                    status: 'dispatched',
                    route: 'direct',
                    storeType: 'Actor',
                    repairTargets: [{
                        type: 'Actor',
                        id: 'actor-missing',
                        reason: 'direct-update-miss',
                    }],
                };
            }
            return { status: 'dispatched', route: 'direct', storeType: payload.type };
        },
        reportRepairUnavailable: event => unavailable.push(event),
        getRuntimeEpoch: () => 9,
    });
    const detach = ingress.attach(transport);

    try {
        const update = {
            response: {
                type: 'Actor',
                action: 'update',
                result: [{ _id: 'actor-missing', name: 'Partial value' }],
            },
        };
        transport.emit('foundry:modifyDocument', update);
        transport.emit('foundry:modifyDocument', update);
        assert.equal(transport.calls.length, 1, 'same-root misses share the active repair read');

        firstRepair.resolve({
            type: 'Actor',
            action: 'get',
            result: [{ _id: 'actor-missing', name: 'Authoritative value' }],
        });
        await waitFor(() => transport.calls.length === 2);

        trailingRepair.resolve({
            type: 'Actor',
            action: 'get',
            result: [{ _id: 'actor-missing', name: 'Trailing authoritative value' }],
        });
        await waitFor(() => routed.filter(entry => entry.action === 'create').length === 2);

        const repairRequests = transport.calls.map(call => call.payloads[0] as {
            type: string;
            operation: { ids: string[]; broadcast: boolean };
        });
        assert.deepEqual(repairRequests, [
            { type: 'Actor', action: 'get', operation: { ids: ['actor-missing'], broadcast: false } },
            { type: 'Actor', action: 'get', operation: { ids: ['actor-missing'], broadcast: false } },
        ]);
        assert.deepEqual(
            routed.filter(entry => entry.action === 'create').map(entry => entry.result),
            [
                [{ _id: 'actor-missing', name: 'Authoritative value' }],
                [{ _id: 'actor-missing', name: 'Trailing authoritative value' }],
            ],
        );
        assert.deepEqual(unavailable, []);
    } finally {
        detach();
    }
}

async function runEmbeddedMissRepairAndUnavailableOutcome() {
    const routed: RoutedDocument[] = [];
    const unavailable: DocumentRepairUnavailableEvent[] = [];
    let directMissEnabled = false;
    const transport = new TestTransport();
    transport.responses.push(Promise.resolve({
        type: 'JournalEntry',
        action: 'get',
        result: [{ _id: 'journal-missing', name: 'Authoritative journal', pages: [] }],
    }));

    const ingress = new FoundryEventIngress({
        routeDocument: (payload) => {
            routed.push(payload);
            if (payload.type === 'JournalEntryPage') {
                return {
                    status: 'dispatched',
                    route: 'embedded',
                    storeType: 'JournalEntry',
                    repairTargets: [{
                        type: 'JournalEntry',
                        id: 'journal-missing',
                        reason: 'embedded-root-miss',
                    }],
                };
            }
            if (directMissEnabled && payload.type === 'Actor' && payload.action === 'update') {
                return {
                    status: 'dispatched',
                    route: 'direct',
                    storeType: 'Actor',
                    repairTargets: [{
                        type: 'Actor',
                        id: 'actor-unavailable',
                        reason: 'direct-update-miss',
                    }],
                };
            }
            return { status: 'dispatched', route: 'direct', storeType: payload.type };
        },
        reportRepairUnavailable: event => unavailable.push(event),
        getRuntimeEpoch: () => 3,
    });
    const detach = ingress.attach(transport);

    try {
        transport.emit('foundry:modifyDocument', {
            response: {
                type: 'JournalEntryPage',
                action: 'update',
                operation: { parentUuid: 'JournalEntry.journal-missing' },
                result: [{ _id: 'page-1', name: 'Partial page' }],
            },
        });
        await waitFor(() => routed.some(entry => entry.type === 'JournalEntry' && entry.action === 'create'));
        assert.deepEqual(unavailable, []);

        transport.responses.push(Promise.resolve({
            type: 'Actor',
            action: 'get',
            result: [],
        }));
        directMissEnabled = true;
        transport.emit('foundry:modifyDocument', {
            response: {
                type: 'Actor',
                action: 'update',
                result: [{ _id: 'actor-unavailable', name: 'Partial actor' }],
            },
        });
        await waitFor(() => unavailable.length === 1);
        assert.deepEqual(unavailable[0], {
            status: 'unavailable',
            rootType: 'Actor',
            rootId: 'actor-unavailable',
            reason: 'empty-response',
        });
    } finally {
        detach();
    }
}

async function runStoreMissRepairAttemptCap() {
    const unavailable: DocumentRepairUnavailableEvent[] = [];
    const transport = new TestTransport();
    const responses = [
        deferred<unknown>(),
        deferred<unknown>(),
        deferred<unknown>(),
    ];
    transport.responses.push(...responses.map(response => response.promise));

    const ingress = new FoundryEventIngress({
        routeDocument: (payload) => {
            if (payload.type === 'Actor' && payload.action === 'update') {
                return {
                    status: 'dispatched',
                    route: 'direct',
                    storeType: 'Actor',
                    repairTargets: [{
                        type: 'Actor',
                        id: 'actor-churning',
                        reason: 'direct-update-miss',
                    }],
                };
            }
            return { status: 'dispatched', route: 'direct', storeType: payload.type };
        },
        reportRepairUnavailable: event => unavailable.push(event),
        getRuntimeEpoch: () => 6,
    });
    const detach = ingress.attach(transport);
    const emitMiss = () => transport.emit('foundry:modifyDocument', {
        response: {
            type: 'Actor',
            action: 'update',
            result: [{ _id: 'actor-churning', name: 'Partial actor' }],
        },
    });
    const authoritative = {
        type: 'Actor',
        action: 'get',
        result: [{ _id: 'actor-churning', name: 'Authoritative actor' }],
    };

    try {
        emitMiss();
        for (let index = 0; index < responses.length; index += 1) {
            emitMiss();
            responses[index].resolve(authoritative);
            if (index < responses.length - 1) {
                await waitFor(() => transport.calls.length === index + 2);
            }
        }

        await waitFor(() => unavailable.length === 1);
        assert.equal(transport.calls.length, 3);
        assert.deepEqual(unavailable[0], {
            status: 'unavailable',
            rootType: 'Actor',
            rootId: 'actor-churning',
            reason: 'coalescing-limit',
        });
    } finally {
        detach();
    }
}

async function runCompendiumLifecycle() {
    const harness = createHarness();
    try {
        harness.transport.emit('foundry:manageCompendium', {
            response: manageCompendiumFixtures.create,
        });
        await waitFor(() => harness.invalidated.length === 1);
        assert.equal(harness.metadata.get('world.new-pack')?.id, 'world.new-pack');
        assert.equal(harness.invalidated[0].reason, 'manageCompendium:create');

        harness.transport.emit('foundry:manageCompendium', {
            response: manageCompendiumFixtures.delete,
        });
        await waitFor(() => harness.removed.length === 1);
        assert.equal(harness.removed[0].packId, 'world.old-pack');
        assert.equal(harness.removed[0].reason, 'manageCompendium:delete');
    } finally {
        harness.detach();
    }
}

export async function run() {
    await runSingleAndBatchRouting();
    await runAutosaveRootRefresh();
    await runAutosaveScopeAndUuidRouting();
    await runStaleAutosaveRefreshIsDiscarded();
    await runRuntimeTeardownDelegation();
    await runStoreMissRepair();
    await runEmbeddedMissRepairAndUnavailableOutcome();
    await runStoreMissRepairAttemptCap();
    await runCompendiumLifecycle();
    console.log('  - Foundry persistence ingress: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('foundry-persistence-ingress.test.ts passed'))
        .catch(error => {
            console.error(error);
            process.exit(1);
        });
}
