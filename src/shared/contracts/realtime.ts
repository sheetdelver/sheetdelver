import type { SystemStatusPayload } from '@shared/contracts/status';

export type RealtimeSystemStatusPayload = SystemStatusPayload;

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

export type RealtimeCombatUpdatePayload = Record<string, unknown>;
export type RealtimeChatUpdatePayload = Record<string, unknown>;
