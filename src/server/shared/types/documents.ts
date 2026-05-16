import type { RollMode } from '@shared/sdk';
import type { FoundryClientLike } from '@server/shared/types/foundry';
import type { RawActor, ActorServiceClientLike } from '@server/shared/types/actors';

export interface RawFolder {
    id?: string;
    _id?: string;
    name?: string;
    type?: string | null;
    parent?: string | null;
    // Local/legacy DTO alias. Stores normalize this to `parent` at the boundary.
    folder?: string | null;
    sort?: number;
    color?: string | null;
    permission?: Record<string, number>;
    flags?: Record<string, unknown>;
    children?: string[];
    private?: boolean;
    img?: string | null;
    [key: string]: unknown;
}

/**
 * A single embedded JournalEntryPage. Pages carry their own ownership map;
 * an explicit `INHERIT` (-1) resolves to the parent entry's effective ownership.
 * Omitted page ownership fails closed unless real Foundry payloads prove a
 * different default during Phase 4 integration.
 */
export interface RawJournalPage {
    id?: string;
    _id?: string;
    name?: string;
    type?: string;
    sort?: number;
    text?: { content?: string; format?: number; [key: string]: unknown };
    image?: { caption?: string; [key: string]: unknown };
    video?: { [key: string]: unknown };
    src?: string | null;
    title?: { show?: boolean; level?: number; [key: string]: unknown };
    ownership?: Record<string, number>;
    flags?: Record<string, unknown>;
    _stats?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface RawJournal {
    id?: string;
    _id?: string;
    name?: string;
    folder?: string | null;
    ownership?: Record<string, number>;
    pages?: RawJournalPage[];
    flags?: Record<string, unknown>;
    _stats?: Record<string, unknown>;
    sort?: number;
    [key: string]: unknown;
}

export interface RawChatMessage {
    id?: string;
    _id?: string;
    content?: string;
    timestamp?: number;
    [key: string]: unknown;
}

export interface RawCombatant {
    id?: string;
    _id?: string;
    actorId?: string;
    initiative?: number;
    [key: string]: unknown;
}

export interface RawCombat {
    id?: string;
    _id?: string;
    round?: number;
    turn?: number;
    combatants?: RawCombatant[];
    [key: string]: unknown;
}

export interface DocumentSocketResponse<T> {
    result?: T[];
    [key: string]: unknown;
}

export interface JournalMutationBody {
    type?: string;
    data: Record<string, unknown>;
}

export interface JournalDeleteQuery {
    type?: string | string[];
}

export interface ChatSendBody {
    message?: string;
    rollMode?: RollMode;
    speaker?: string | {
        actor?: string;
        alias?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export interface RollChatMessageLike {
    content?: string;
    [key: string]: unknown;
}

export interface JournalClientLike extends FoundryClientLike {
    userId?: string | null;
    dispatchDocument(
        type: string,
        action: string,
        operation?: unknown,
        parent?: { type: string; id: string }
    ): Promise<unknown>;
}

export interface ChatClientLike extends FoundryClientLike {
    getChatLog(limit: number): Promise<RawChatMessage[]>;
    createChatMessage(data: Record<string, unknown>): Promise<unknown>;
    dispatchDocument(
        type: string,
        action: string,
        operation?: unknown,
        parent?: { type: string; id: string }
    ): Promise<unknown>;
    roll(
        formula: string,
        label?: string,
        options?: {
            rollMode?: RollMode;
            speaker?: ChatSendBody['speaker'];
            displayChat?: boolean;
            [key: string]: unknown;
        }
    ): Promise<unknown>;
}

export interface CombatClientLike extends ActorServiceClientLike {
    getCombats(): Promise<RawCombat[]>;
    getActor(actorId: string): Promise<(RawActor & { error?: string }) | null | undefined>;
    dispatchDocumentSocket(
        type: string,
        action: 'update',
        payload: Record<string, unknown>,
        context?: Record<string, unknown>
    ): Promise<unknown>;
    roll(
        formula: string,
        label: string,
        options?: { speaker?: { actor?: string; alias?: string } }
    ): Promise<RollChatMessageLike>;
}
