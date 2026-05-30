import { strict as assert } from 'node:assert';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';
import { subscribeSharedContentRealtime } from '@client/ui/hooks/useSharedContentRealtime';

class FakeSocket {
    private handler: ((payload: RealtimeSharedContentPayload) => void) | null = null;

    on(event: 'sharedContentUpdate', handler: (payload: RealtimeSharedContentPayload) => void) {
        assert.equal(event, 'sharedContentUpdate');
        this.handler = handler;
    }

    off(event: 'sharedContentUpdate', handler: (payload: RealtimeSharedContentPayload) => void) {
        assert.equal(event, 'sharedContentUpdate');
        if (this.handler === handler) {
            this.handler = null;
        }
    }

    emit(payload: RealtimeSharedContentPayload) {
        this.handler?.(payload);
    }

    get listenerCount() {
        return this.handler ? 1 : 0;
    }
}

export function run() {
    const socket = new FakeSocket();
    let current: RealtimeSharedContentPayload | null = {
        type: 'image',
        data: { title: 'Map', url: '/map.webp' },
        timestamp: 1,
    };
    const updates: RealtimeSharedContentPayload[] = [];

    const cleanup = subscribeSharedContentRealtime({
        appSocket: socket,
        getSharedContent: () => current,
        setSharedContent: (next) => {
            current = next;
            updates.push(next);
        },
    });

    assert.equal(socket.listenerCount, 1);

    socket.emit({
        timestamp: 1,
        data: { url: '/map.webp', title: 'Map' },
        type: 'image',
    });
    assert.equal(updates.length, 0);

    socket.emit({
        type: 'journal',
        data: { id: 'journal-1', title: 'Clue' },
        timestamp: 2,
    });
    assert.equal(updates.length, 1);
    assert.equal(current?.type, 'journal');

    cleanup();
    assert.equal(socket.listenerCount, 0);

    socket.emit({
        type: 'image',
        data: { title: 'After cleanup' },
        timestamp: 3,
    });
    assert.equal(updates.length, 1);

    console.log('  - Shared-content realtime subscription: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('shared-content-realtime.test.ts passed');
}
