import type { RealtimeStatusPayload } from '@shared/contracts/status';

export type RealtimeSystemStatusPayload = RealtimeStatusPayload;

// Actor socket events are invalidation hints; clients refetch instead of applying diffs.
export interface RealtimeActorChangedPayload {
    actorId: string;
    action: 'create' | 'update' | 'delete';
}

export interface RealtimeSharedContentPayload {
    type: 'image' | 'journal' | null;
    data?: {
        url?: string;
        title?: string;
        id?: string;
        uuid?: string;
        [key: string]: unknown;
    };
    timestamp?: number;
    [key: string]: unknown;
}

export interface RealtimeCombatChangedPayload {
    combatId: string;
    action: 'create' | 'update' | 'delete';
}
export interface RealtimeCombatListInvalidatedPayload {
    reason: string;
    combatId?: string;
    targetUserIds?: string[];
}
export interface RealtimeItemChangedPayload {
    itemId: string;
    action: 'create' | 'update' | 'delete';
}
export interface RealtimeItemListInvalidatedPayload {
    reason: string;
    itemId?: string;
    targetUserIds?: string[];
}
export interface RealtimeChatMessageChangedPayload {
    messageId: string;
    action: 'create' | 'update' | 'delete';
}
export interface RealtimeChatMessageListInvalidatedPayload {
    reason: string;
    messageId?: string;
    targetUserIds?: string[];
}

// Phase 7 — RollTable + Macro. No in-tree browser consumer yet; contracts
// ship for SDK consumers and to keep the wire surface uniform across Stores.
export interface RealtimeRollTableChangedPayload {
    rollTableId: string;
    action: 'create' | 'update' | 'delete';
}
export interface RealtimeRollTableListInvalidatedPayload {
    reason: string;
    rollTableId?: string;
    targetUserIds?: string[];
}
export interface RealtimeMacroChangedPayload {
    macroId: string;
    action: 'create' | 'update' | 'delete';
}
export interface RealtimeMacroListInvalidatedPayload {
    reason: string;
    macroId?: string;
    targetUserIds?: string[];
}
export interface RealtimePlaylistChangedPayload {
    playlistId: string;
    action: 'create' | 'update' | 'delete';
}
export interface RealtimePlaylistListInvalidatedPayload {
    reason: string;
    playlistId?: string;
    targetUserIds?: string[];
}
export interface RealtimeCardsChangedPayload {
    cardsId: string;
    action: 'create' | 'update' | 'delete';
}
export interface RealtimeCardsListInvalidatedPayload {
    reason: string;
    cardsId?: string;
    targetUserIds?: string[];
}
