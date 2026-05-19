import { strict as assert } from 'node:assert';
import {
    SharedContentStore,
    type SharedContentChangedEvent,
    type SharedContentPayload,
} from '@server/core/world/SharedContentStore';

export async function run() {
    await runInitialState();
    await runSetAndGet();
    await runDefensiveCopyOnRead();
    await runDefensiveCopyOnWrite();
    await runEventFiresOnSetAndClear();
    await runClearIdempotent();
    await runUnsubscribe();
    console.log('  - SharedContentStore: all checks passed');
}

function buildImagePayload(): SharedContentPayload {
    return {
        type: 'image',
        data: { url: 'icons/foo.png', title: 'Foo' },
        timestamp: 1700000000000,
    };
}

async function runInitialState() {
    const store = new SharedContentStore();
    assert.equal(store.getCurrent(), null);
}

async function runSetAndGet() {
    const store = new SharedContentStore();
    const payload = buildImagePayload();
    store.set(payload);

    const got = store.getCurrent();
    assert.ok(got);
    assert.equal(got.type, 'image');
    assert.equal(got.data?.url, 'icons/foo.png');
    assert.equal(got.timestamp, 1700000000000);
}

async function runDefensiveCopyOnRead() {
    // Mutating a value returned from getCurrent() must not affect the next read.
    const store = new SharedContentStore();
    store.set(buildImagePayload());

    const first = store.getCurrent();
    assert.ok(first);
    if (first.data) first.data.url = 'icons/hijacked.png';

    const second = store.getCurrent();
    assert.equal(second?.data?.url, 'icons/foo.png', 'second read should be unaffected by mutation of first');
}

async function runDefensiveCopyOnWrite() {
    // Mutating the original input reference after set() must not affect the
    // canonical Store snapshot — the wire listener may reuse a payload object.
    const store = new SharedContentStore();
    const payload = buildImagePayload();
    store.set(payload);

    if (payload.data) payload.data.url = 'icons/hijacked.png';

    const got = store.getCurrent();
    assert.equal(got?.data?.url, 'icons/foo.png', 'Store snapshot should be detached from caller reference');
}

async function runEventFiresOnSetAndClear() {
    const store = new SharedContentStore();
    const events: SharedContentChangedEvent[] = [];
    store.onSharedContentChanged((event) => events.push(event));

    store.set(buildImagePayload());
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'set');
    assert.equal(events[0].payload?.type, 'image');

    store.clear('test-clear');
    assert.equal(events.length, 2);
    assert.equal(events[1].reason, 'clear');
    assert.equal(events[1].payload, null);

    // Event payloads are themselves defensive copies — mutating one must not
    // affect the next.
    if (events[0].payload?.data) events[0].payload.data.url = 'icons/hijacked.png';
    const got = store.getCurrent();
    assert.equal(got, null, 'after clear the Store is empty regardless of event-payload mutation');
}

async function runClearIdempotent() {
    const store = new SharedContentStore();
    const events: SharedContentChangedEvent[] = [];
    store.onSharedContentChanged((event) => events.push(event));

    // Initial state is already null — clearing again should not emit.
    store.clear('redundant');
    assert.equal(events.length, 0);

    store.set(buildImagePayload());
    assert.equal(events.length, 1);

    store.clear('first-real-clear');
    assert.equal(events.length, 2);

    store.clear('second-redundant-clear');
    assert.equal(events.length, 2, 'consecutive clears do not re-emit');
}

async function runUnsubscribe() {
    const store = new SharedContentStore();
    const events: SharedContentChangedEvent[] = [];
    const unsubscribe = store.onSharedContentChanged((event) => events.push(event));

    store.set(buildImagePayload());
    assert.equal(events.length, 1);

    unsubscribe();
    store.set({ type: 'journal', data: { id: 'j-1', uuid: 'JournalEntry.j-1' }, timestamp: 0 });
    assert.equal(events.length, 1, 'unsubscribed listener does not receive further events');
}
