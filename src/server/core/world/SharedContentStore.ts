import { EventEmitter } from 'node:events';
import { cloneDocument } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';

export type SharedContentPayload = RealtimeSharedContentPayload;

export interface SharedContentChangedEvent {
    payload: SharedContentPayload | null;
    reason: 'set' | 'clear';
}

function cloneOrNull<T>(value: T | null | undefined): T | null {
    return value == null ? null : cloneDocument(value);
}

/**
 * Store-owned home for GM-shared content (`shareImage`, `showEntry`).
 *
 * Held separately from `WorldStateStore` because the event source is asymmetric
 * (live wire events, not the world bootstrap payload) and the lifecycle is
 * independent (presentation state can change without re-bootstrapping the
 * world).
 *
 * Immutability contract: writes accept any payload shape; reads return a
 * defensive copy. Request projections — URL resolution, journal hydration —
 * cannot mutate canonical state by mutating their returned reference. The
 * stored payload stays relative/raw; presentation-time URL resolution happens
 * outside the Store at the request boundary.
 */
export class SharedContentStore extends EventEmitter {
    private current: SharedContentPayload | null = null;

    public getCurrent(): SharedContentPayload | null {
        return cloneOrNull(this.current);
    }

    public set(payload: SharedContentPayload | null | undefined): void {
        // Clone on write to detach the Store snapshot from the caller's
        // reference; if the listener emitted the same object across multiple
        // socket events, mutations to that object would otherwise leak through.
        // The Store preserves the raw payload as provided; SocketBase stamps
        // wire events with timestamps before handing them over.
        this.current = payload == null ? null : cloneDocument(payload);
        const event: SharedContentChangedEvent = {
            payload: cloneOrNull(this.current),
            reason: 'set',
        };
        this.emit('sharedContentChanged', event);
    }

    public clear(_reason?: string): void {
        // Idempotent clear: do not rebroadcast an empty shared-content state
        // when nothing was previously shared.
        if (this.current === null) return;
        this.current = null;
        const event: SharedContentChangedEvent = {
            payload: null,
            reason: 'clear',
        };
        this.emit('sharedContentChanged', event);
    }

    public onSharedContentChanged(listener: (event: SharedContentChangedEvent) => void): () => void {
        this.on('sharedContentChanged', listener);
        return () => {
            this.off('sharedContentChanged', listener);
        };
    }
}

export const sharedContentStore = new SharedContentStore();
