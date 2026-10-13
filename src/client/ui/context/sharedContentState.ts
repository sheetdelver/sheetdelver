import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';

// One bounded record per browser tab; storage denial must never prevent closing.
const DISMISSAL_KEY = 'sheetdelver:dismissed-share';
type ShareStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readDismissedShare(storage: ShareStorage): string | null {
    try {
        const key = storage.getItem(DISMISSAL_KEY);
        return key && key.length <= 4096 ? key : null;
    } catch { return null; }
}

export function rememberDismissedShare(storage: ShareStorage, key: string): void {
    try { if (key.length <= 4096) storage.setItem(DISMISSAL_KEY, key); } catch { /* In-memory dismissal still applies. */ }
}

export function sharedContentKey(worldId: string, userId: string, share: RealtimeSharedContentPayload): string {
    return JSON.stringify([worldId, userId, share.streamId ?? '',
        share.shareId ?? (typeof share.sequence === 'number' ? `receipt:${share.sequence}` : `${share.timestamp ?? 0}:${share.type}`)]);
}

/** Sequence is local to one server session stream; no client clock comparison. */
export function latestSharedContent(
    current: RealtimeSharedContentPayload | null,
    incoming: RealtimeSharedContentPayload | null,
): RealtimeSharedContentPayload | null {
    if (!incoming) return current;
    if (current?.streamId && current.streamId === incoming.streamId
        && typeof current.sequence === 'number' && typeof incoming.sequence === 'number'
        && incoming.sequence <= current.sequence) return current;
    return incoming;
}

export function applySharedContentSnapshot(current: RealtimeSharedContentPayload | null,
    snapshot: RealtimeSharedContentPayload | null, requestedAt: number, receiptVersion: number) {
    return requestedAt === receiptVersion ? latestSharedContent(current, snapshot) : current;
}
