import { cloneDocument } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';

export type SharedContentPayload = RealtimeSharedContentPayload;

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

    public getCurrent(sessionId: string, worldId: string): SharedContentPayload | null {
        const share = this.bySession.get(sessionId);
        if (!share || share.worldId !== worldId || !share.payload) return null;
        return cloneDocument(share.payload);
    }

    public set(sessionId: string, worldId: string, payload: SharedContentPayload): void {
        if (!sessionId || !worldId) return;
        this.bySession.set(sessionId, { worldId, payload: cloneDocument(payload) });
    }

    public clearSession(sessionId: string): void {
        this.bySession.delete(sessionId);
    }

    public clear(_reason?: string): void {
        this.bySession.clear();
    }
}

export const sharedContentStore = new SharedContentStore();
