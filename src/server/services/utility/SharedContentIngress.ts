import type { FoundryClientLike } from '@server/shared/types/foundry';
import { sharedContentStore, type SharedContentStore } from '@server/core/world/SharedContentStore';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';
import { isRecord } from '@server/core/documents/primary/base/PrimaryDocumentStore';

/** Bound once to the authenticated Foundry session, independently of browser tabs. */
export function attachSharedContentIngress(client: FoundryClientLike, scope: {
    sessionId: string; worldId: string;
    isCurrent: () => boolean;
}, store: SharedContentStore = sharedContentStore): () => void {
    const deliver = (payload: RealtimeSharedContentPayload) => {
        if (scope.isCurrent()) store.set(scope.sessionId, scope.worldId, payload);
    };
    const identity = (raw: Record<string, unknown>) => ({
        timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(),
        shareId: typeof raw.shareId === 'string' ? raw.shareId : undefined,
    });
    const image = (raw: unknown) => {
        if (!isRecord(raw) || !isRecord(raw.data) || typeof raw.data.image !== 'string' || !raw.data.image) return;
        deliver({ type: 'image', data: { url: raw.data.image,
            title: typeof raw.data.title === 'string' ? raw.data.title : undefined }, ...identity(raw) });
    };
    const journal = (raw: unknown) => {
        if (!isRecord(raw) || typeof raw.uuid !== 'string') return;
        const parts = raw.uuid.split('.');
        if (parts[0] !== 'JournalEntry' || !parts[1]
            || (parts.length !== 2 && (parts.length !== 4 || parts[2] !== 'JournalEntryPage' || !parts[3]))) return;
        // Foundry relays force as the first positional argument; browsers do
        // not supply this authority when opening the corresponding view.
        const force = Array.isArray(raw.args) && raw.args[0] === true;
        deliver({ type: 'journal', data: { id: parts[1], uuid: raw.uuid, pageId: parts[3], force }, ...identity(raw) });
    };
    client.on('foundry:shareImage', image);
    client.on('foundry:showEntry', journal);
    return () => {
        client.off('foundry:shareImage', image);
        client.off('foundry:showEntry', journal);
    };
}
