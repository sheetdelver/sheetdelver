import { strict as assert } from 'node:assert';
import { SharedContentStore, type SharedContentPayload } from '@server/core/world/SharedContentStore';

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
    assert.deepEqual(store.getCurrent('alice', 'world-a'), image());
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
    console.log('  - SharedContentStore: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().catch(error => { console.error(error); process.exit(1); });
}
