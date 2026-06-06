import { strict as assert } from 'node:assert';
import { createSdkEventBus } from '@client/ui/sdk/createSdkEventBus';

/**
 * Exercises the host realtime signal bus (ADR-0027 decision 20): socket events map to the
 * stable SDK signal set, combat rides document:changed, unsubscribe works, and
 * connection transitions surface world:ready / world:teardown.
 */

class FakeSocket {
    private handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    on(event: string, handler: (...args: unknown[]) => void) {
        let set = this.handlers.get(event);
        if (!set) { set = new Set(); this.handlers.set(event, set); }
        set.add(handler);
    }
    off(event: string, handler: (...args: unknown[]) => void) {
        this.handlers.get(event)?.delete(handler);
    }
    emit(event: string, payload: unknown) {
        this.handlers.get(event)?.forEach((h) => h(payload));
    }
    count(event: string) { return this.handlers.get(event)?.size ?? 0; }
}

export function run() {
    const socket = new FakeSocket();
    const bus = createSdkEventBus();
    bus.attach(socket as any);

    // actorChanged → document:changed { type: 'Actor' }
    const changes: Array<{ type: string; id: string; action: string }> = [];
    const offChange = bus.on('document:changed', (p) => changes.push(p));

    socket.emit('actorChanged', { actorId: 'a1', action: 'update' });
    socket.emit('combatChanged', { combatId: 'c1', action: 'create' });
    socket.emit('itemChanged', { itemId: 'i1', action: 'delete' });

    assert.deepEqual(changes[0], { type: 'Actor', id: 'a1', action: 'update' });
    // Combat rides document:changed — no special-casing.
    assert.deepEqual(changes[1], { type: 'Combat', id: 'c1', action: 'create' });
    assert.deepEqual(changes[2], { type: 'Item', id: 'i1', action: 'delete' });

    // Unsubscribe stops delivery.
    offChange();
    socket.emit('actorChanged', { actorId: 'a2', action: 'update' });
    assert.equal(changes.length, 3, 'no delivery after unsubscribe');

    // list invalidation
    const lists: Array<{ type: string; reason: string }> = [];
    bus.on('document:listInvalidated', (p) => lists.push(p));
    socket.emit('combatListInvalidated', { reason: 'reseed' });
    assert.deepEqual(lists[0], { type: 'Combat', reason: 'reseed' });

    // shared content
    const shares: Array<{ kind: string | null }> = [];
    bus.on('content:shared', (p) => shares.push(p));
    socket.emit('sharedContentUpdate', { type: 'image', data: { url: '/x.png' } });
    assert.equal(shares[0].kind, 'image');

    // connection transitions: connection:changed always; world:ready/teardown on flip
    const conns: boolean[] = [];
    const lifecycle: string[] = [];
    bus.on('connection:changed', (p) => conns.push(p.connected));
    bus.on('world:ready', () => lifecycle.push('ready'));
    bus.on('world:teardown', () => lifecycle.push('teardown'));

    socket.emit('systemStatus', { connected: true, worldId: 'w1' });   // first status: no flip event
    socket.emit('systemStatus', { connected: false, worldId: 'w1' });  // true → false: teardown
    socket.emit('systemStatus', { connected: true, worldId: 'w1' });   // false → true: ready

    assert.deepEqual(conns, [true, false, true]);
    assert.deepEqual(lifecycle, ['teardown', 'ready']);

    // Regression (the real-world bug): a subscriber registered once must keep receiving
    // events after the socket is re-attached. Binding the socket used to happen at creation
    // (in useMemo), so a re-render rebuilt a second bus bound to the socket while the
    // subscriber stayed on the first — events were silently dropped. With attach/detach the
    // subscriber lives on the stable bus and survives re-binding.
    {
        const reBus = createSdkEventBus();
        const sockA = new FakeSocket();
        const seen: string[] = [];
        reBus.on('document:changed', (p) => seen.push(p.id));

        reBus.attach(sockA as any);
        sockA.emit('actorChanged', { actorId: 'before', action: 'update' });

        // Re-attach a different socket (simulates appSocket reconnect / a new render).
        const sockB = new FakeSocket();
        reBus.attach(sockB as any);
        assert.equal(sockA.count('actorChanged'), 0, 're-attach detaches the previous socket');
        sockB.emit('actorChanged', { actorId: 'after', action: 'update' });

        assert.deepEqual(seen, ['before', 'after'], 'subscriber survives socket re-attach');
        reBus.dispose();
    }

    // dispose detaches all socket handlers.
    bus.dispose();
    assert.equal(socket.count('actorChanged'), 0, 'dispose removes socket handlers');

    console.log('  - SDK event bus (signal mapping): all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('sdk-event-bus.test.ts passed');
}
