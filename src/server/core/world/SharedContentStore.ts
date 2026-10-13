import { cloneDocument } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';
import { randomUUID } from 'node:crypto';

export type SharedContentPayload = RealtimeSharedContentPayload;
export interface ScopedShareUpdate { sessionId: string; worldId: string; payload: SharedContentPayload }

interface ScopedShare {
    worldId: string;
    payload: SharedContentPayload | null;
}

/**
 * Latest Foundry share received by each authenticated user transport. A
 * service-account receipt has no authority to address other sessions. The
 * world id prevents a stale snapshot from crossing a world boundary.
 */
export class SharedContentStore {
    private readonly bySession = new Map<string, ScopedShare>();
    private readonly listeners = new Set<(update: ScopedShareUpdate) => void>();

    public onChanged(listener: (update: ScopedShareUpdate) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    public getCurrent(sessionId: string, worldId: string): SharedContentPayload | null {
        const share = this.bySession.get(sessionId);
        if (!share || share.worldId !== worldId || !share.payload) return null;
        return cloneDocument(share.payload);
    }

    public set(sessionId: string, worldId: string, payload: SharedContentPayload): void {
        if (!sessionId || !worldId) return;
        const current = this.getCurrent(sessionId, worldId);
        if (payload.shareId && current?.shareId === payload.shareId) return;
        const next = { ...cloneDocument(payload), streamId: current?.streamId ?? randomUUID(),
            sequence: (current?.sequence ?? 0) + 1 };
        this.bySession.set(sessionId, { worldId, payload: next });
        for (const listener of this.listeners) listener({ sessionId, worldId, payload: cloneDocument(next) });
    }

    public clearSession(sessionId: string): void {
        this.bySession.delete(sessionId);
    }

    public clear(_reason?: string): void {
        this.bySession.clear();
    }
}

export const sharedContentStore = new SharedContentStore();
