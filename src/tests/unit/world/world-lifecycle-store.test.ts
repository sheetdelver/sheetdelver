import { strict as assert } from 'node:assert';
import {
    WorldLifecycleStore,
    type WorldLifecycleTransition,
} from '@server/core/world/WorldLifecycleStore';

export async function run() {
    await runInitialSnapshot();
    await runTransitions();
    await runIdempotentSet();
    await runReset();
    console.log('  - WorldLifecycleStore: all checks passed');
}

async function runInitialSnapshot() {
    const store = new WorldLifecycleStore();
    assert.equal(store.getState(), 'offline');
    assert.equal(store.isState('offline'), true);
    assert.deepEqual(store.getSnapshot(), {
        state: 'offline',
        lastTransition: null,
    });
}

async function runTransitions() {
    const store = new WorldLifecycleStore();
    const events: WorldLifecycleTransition[] = [];
    store.on('transition', (event: WorldLifecycleTransition) => events.push(event));

    const transition = store.setState('startup', 'test-startup');

    assert.ok(transition);
    assert.equal(transition.from, 'offline');
    assert.equal(transition.to, 'startup');
    assert.equal(transition.reason, 'test-startup');
    assert.equal(store.getState(), 'startup');
    assert.equal(events.length, 1);
    assert.equal(events[0].from, 'offline');
    assert.equal(events[0].to, 'startup');

    events[0].to = 'closed';
    assert.equal(store.getSnapshot().lastTransition?.to, 'startup');
}

async function runIdempotentSet() {
    const store = new WorldLifecycleStore();
    const events: WorldLifecycleTransition[] = [];
    store.on('transition', (event: WorldLifecycleTransition) => events.push(event));

    assert.equal(store.setState('offline', 'same-state'), null);
    assert.equal(events.length, 0);
    assert.equal(store.getSnapshot().lastTransition, null);
}

async function runReset() {
    const store = new WorldLifecycleStore();
    store.setState('active', 'test-active');
    const reset = store.reset('test-reset');

    assert.ok(reset);
    assert.equal(reset.from, 'active');
    assert.equal(reset.to, 'offline');
    assert.equal(reset.reason, 'test-reset');
    assert.equal(store.getState(), 'offline');
}
