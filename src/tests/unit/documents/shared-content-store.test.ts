import { strict as assert } from 'node:assert';
import { SharedContentStore, type SharedContentPayload } from '@server/core/world/SharedContentStore';
import { EventEmitter } from 'node:events';
import { attachSharedContentIngress } from '@server/services/utility/SharedContentIngress';

const image = (): SharedContentPayload => ({
    type: 'image',
    data: { url: 'icons/foo.png', title: 'Foo' },
    timestamp: 1700000000000,
});

export async function run() {
    const store = new SharedContentStore();
    assert.equal(store.getCurrent('alice', 'world-a'), null);

    const input = image();
    store.set('alice', 'world-a', input);
    const first = store.getCurrent('alice', 'world-a')!;
    assert.deepEqual(first.data, image().data);
    assert.equal(first.sequence, 1);
    assert.ok(first.streamId);
    assert.equal(store.getCurrent('bob', 'world-a'), null, 'another recipient sees no share');
    assert.equal(store.getCurrent('alice', 'world-b'), null, 'another world sees no share');

    if (input.data) input.data.url = 'mutated-input.png';
    const output = store.getCurrent('alice', 'world-a');
    if (output?.data) output.data.url = 'mutated-output.png';
    assert.equal(store.getCurrent('alice', 'world-a')?.data?.url, 'icons/foo.png');

    store.set('bob', 'world-a', { type: 'journal', data: { id: 'j-1' } });
    store.clearSession('alice');
    assert.equal(store.getCurrent('alice', 'world-a'), null);
    assert.equal(store.getCurrent('bob', 'world-a')?.type, 'journal');

    store.clear('world-closed');
    assert.equal(store.getCurrent('bob', 'world-a'), null);
    const client = new EventEmitter();
    let authorized = true;
    const receipts: SharedContentPayload[] = [];
    const unsubscribe = store.onChanged(update => receipts.push(update.payload));
    const detach = attachSharedContentIngress(client, {
        sessionId: 'alice', worldId: 'world-a', isCurrent: () => authorized,
    }, store);
    // No app browser is attached. The retained user session still records shares.
    client.emit('foundry:shareImage', { data: { image: '/a.png' }, shareId: 'one' });
    client.emit('foundry:shareImage', { data: { image: '/a.png' }, shareId: 'one' });
    assert.equal(receipts.length, 1, 'duplicate receipt does not create another presentation');
    client.emit('foundry:shareImage', { data: { image: '/a.png' }, shareId: 'two' });
    assert.equal(store.getCurrent('alice', 'world-a')?.sequence, 2, 'identical URL can be shared again');
    client.emit('foundry:showEntry', { uuid: 'JournalEntry.j.JournalEntryPage.p', shareId: 'three' });
    assert.equal(store.getCurrent('alice', 'world-a')?.data?.pageId, 'p');
    assert.equal(store.getCurrent('bob', 'world-a'), null);
    client.emit('foundry:showEntry', { uuid: 'Actor.secret', shareId: 'bad' });
    assert.equal(receipts.length, 3);
    const caption = '<img src=x onerror="alert(1)"> Caption';
    client.emit('foundry:shareImage', { data: { image: '/a.png', caption }, shareId: 'caption' });
    assert.equal(store.getCurrent('alice', 'world-a')?.data?.caption, caption, 'caption remains inert text for rendering');
    assert.equal(store.getCurrent('bob', 'world-a'), null, 'caption does not broaden the share audience');
    client.emit('foundry:shareImage', { data: { image: '/a.png', caption: 'x'.repeat(5000) }, shareId: 'long-caption' });
    assert.equal(store.getCurrent('alice', 'world-a')?.data?.caption?.length, 4096);
    client.emit('foundry:shareImage', { data: { image: '/a.png', caption: { html: 'invalid' } }, shareId: 'invalid-caption' });
    assert.equal(store.getCurrent('alice', 'world-a')?.data?.caption, undefined);
    authorized = false;
    client.emit('foundry:shareImage', { data: { image: '/retired.png' }, shareId: 'four' });
    assert.equal(receipts.length, 6, 'retired authority cannot ingest late shares');
    detach();
    unsubscribe();
    assert.equal(client.listenerCount('foundry:shareImage'), 0);
    assert.equal(client.listenerCount('foundry:showEntry'), 0);
    console.log('  - SharedContentStore: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().catch(error => { console.error(error); process.exit(1); });
}
