import { strict as assert } from 'node:assert';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';
import { subscribeSharedContentRealtime } from '@client/ui/hooks/useSharedContentRealtime';
import { applySharedContentSnapshot, latestSharedContent, readDismissedShare, rememberDismissedShare, sharedContentKey } from '@client/ui/context/sharedContentState';

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

    const newer = { type: 'image' as const, shareId: 'new', streamId: 'session-stream', sequence: 2,
        data: { url: '/same.png' } };
    const older = { ...newer, shareId: 'old', sequence: 1 };
    assert.equal(latestSharedContent(newer, older), newer, 'late snapshot cannot replace a newer receipt');
    assert.equal(latestSharedContent(newer, null), newer, 'empty snapshot cannot erase a realtime receipt');
    assert.equal(applySharedContentSnapshot(newer, { type: null }, 0, 1), newer, 'late empty HTTP reply cannot erase live content');
    assert.equal(applySharedContentSnapshot(newer, { ...older, streamId: 'old-process' }, 0, 1), newer,
        'receipt during HTTP request wins even across a server stream restart');
    assert.equal(applySharedContentSnapshot(null, older, 0, 1), null, 'retirement invalidates a pending snapshot');
    assert.equal(applySharedContentSnapshot(newer, older, 1, 1), newer, 'same-stream ordering also guards fresh snapshots');
    const reshare = { ...newer, shareId: 'reshare', sequence: 3 };
    assert.equal(latestSharedContent(newer, reshare), reshare);
    assert.notEqual(sharedContentKey('w', 'u', newer), sharedContentKey('w', 'u', reshare));
    assert.notEqual(sharedContentKey('w', 'u', { ...newer, shareId: undefined }),
        sharedContentKey('w', 'u', { ...reshare, shareId: undefined }), 'receipt ordering also identifies unstamped fixtures');
    assert.notEqual(sharedContentKey('w', 'u', newer), sharedContentKey('w', 'other', newer));
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); } };
    for (let index = 0; index < 1000; index++) rememberDismissedShare(storage, String(index));
    assert.equal(values.size, 1, 'dismissal storage stays bounded');
    assert.equal(readDismissedShare(storage), '999');
    const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    assert.equal(readDismissedShare(denied), null);
    assert.doesNotThrow(() => rememberDismissedShare(denied, 'share'));
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
