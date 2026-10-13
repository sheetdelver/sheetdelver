import { cloneDocument } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';
import { randomUUID } from 'node:crypto';
import type { SharedJournalReceipt, SharedJournalView } from '@shared/contracts/journals';

export type SharedContentPayload = RealtimeSharedContentPayload;
export interface ScopedShareUpdate { sessionId: string; worldId: string; payload: SharedContentPayload }

interface ScopedShare {
    worldId: string;
    payload: SharedContentPayload | null;
    journalViews: Map<string, number>;
}

export interface SharedJournalAccess { journalId: string; pageId?: string; force: boolean }
export class JournalViewLimitError extends Error {}
const JOURNAL_VIEW_IDLE_MS = 30 * 60 * 1000;
const MAX_JOURNAL_VIEWS = 16;

/**
 * Latest Foundry share received by each authenticated user transport. A
 * service-account receipt has no authority to address other sessions. The
 * world id prevents a stale snapshot from crossing a world boundary.
 */
export class SharedContentStore {
    private readonly bySession = new Map<string, ScopedShare>();
    private readonly listeners = new Set<(update: ScopedShareUpdate) => void>();
    constructor(private readonly now: () => number = Date.now) {}

    public openJournalView(sessionId: string, worldId: string, identity: SharedJournalReceipt): SharedJournalView | null {
        const share = this.bySession.get(sessionId);
        const payload = share?.payload;
        if (!share || share.worldId !== worldId || payload?.type !== 'journal'
            || payload.streamId !== identity.streamId || payload.sequence !== identity.sequence
            || payload.shareId !== identity.shareId || typeof payload.data?.id !== 'string') return null;
        const now = this.now();
        for (const [id, expiresAt] of share.journalViews) if (expiresAt <= now) share.journalViews.delete(id);
        if (share.journalViews.size >= MAX_JOURNAL_VIEWS) throw new JournalViewLimitError('Too many open journal views');
        const view = { viewId: randomUUID(), expiresAt: now + JOURNAL_VIEW_IDLE_MS };
        share.journalViews.set(view.viewId, view.expiresAt);
        return view;
    }

    public getJournalViewAccess(sessionId: string, worldId: string, viewId: string): SharedJournalAccess | null {
        const share = this.bySession.get(sessionId);
        const expiresAt = share?.journalViews.get(viewId);
        const payload = share?.payload;
        if (!share || share.worldId !== worldId || !expiresAt || expiresAt <= this.now()
            || payload?.type !== 'journal' || typeof payload.data?.id !== 'string') {
            // A failed lookup in another world must not revoke the rightful view.
            if (share?.worldId === worldId) share.journalViews.delete(viewId);
            return null;
        }
        share.journalViews.set(viewId, this.now() + JOURNAL_VIEW_IDLE_MS);
        return { journalId: payload.data.id,
            pageId: typeof payload.data.pageId === 'string' ? payload.data.pageId : undefined,
            force: payload.data.force === true };
    }

    public closeJournalView(sessionId: string, worldId: string, viewId: string): void {
        const share = this.bySession.get(sessionId);
        if (share?.worldId === worldId) share.journalViews.delete(viewId);
    }

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
        const next = { ...cloneDocument(payload), shareId: payload.shareId ?? randomUUID(), streamId: current?.streamId ?? randomUUID(),
            sequence: (current?.sequence ?? 0) + 1 };
        this.bySession.set(sessionId, { worldId, payload: next, journalViews: new Map() });
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
