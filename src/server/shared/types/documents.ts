import type { RollMode } from '@shared/sdk';
import type { FoundryClientLike, FoundryUserLike } from '@server/shared/types/foundry';
import type { RawActor, ActorServiceClientLike } from '@server/shared/types/actors';

export interface RawFolder {
    id?: string;
    _id?: string;
    folder?: string | null;
    name?: string;
    type?: string;
    [key: string]: unknown;
}

export interface RawJournal {
    id?: string;
    _id?: string;
    folder?: string | null;
    ownership?: Record<string, number>;
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
    speaker?: {
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
    getJournals(): Promise<RawJournal[]>;
    getFolders(type: string): Promise<RawFolder[]>;
    getUsers(): Promise<FoundryUserLike[]>;
    dispatchDocumentSocket(
        type: string,
        action: 'create' | 'get' | 'update' | 'delete',
        payload: Record<string, unknown>
    ): Promise<DocumentSocketResponse<RawJournal> | Record<string, unknown>>;
}

export interface ChatClientLike extends FoundryClientLike {
    getChatLog(limit: number): Promise<RawChatMessage[]>;
    roll(
        formula: string,
        label?: string,
        options?: {
            rollMode?: RollMode;
            speaker?: ChatSendBody['speaker'];
            [key: string]: unknown;
        }
    ): Promise<unknown>;
    sendMessage(
        message: string,
        options?: {
            rollMode?: RollMode;
            speaker?: ChatSendBody['speaker'];
            [key: string]: unknown;
        }
    ): Promise<unknown>;
}

export interface CombatClientLike extends ActorServiceClientLike {
    getCombats(): Promise<RawCombat[]>;
    getUsers(): Promise<FoundryUserLike[]>;
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
