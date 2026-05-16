import type { SystemStatusPayload } from '@shared/contracts/status';

export type RealtimeSystemStatusPayload = SystemStatusPayload;

// Actor socket events are invalidation hints; clients refetch instead of applying diffs.
export interface RealtimeActorUpdatePayload {
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
export type RealtimeChatUpdatePayload = Record<string, unknown>;
export interface RealtimeChatMessageChangedPayload {
    messageId: string;
    action: 'create' | 'update' | 'delete';
}
export interface RealtimeChatMessageListInvalidatedPayload {
    reason: string;
    messageId?: string;
    targetUserIds?: string[];
}
