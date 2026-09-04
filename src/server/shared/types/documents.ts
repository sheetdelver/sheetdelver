import type { RollMode } from '@shared/sdk';
import type { FoundryClientLike } from '@server/shared/types/foundry';
import type { ActorDocument, ActorServiceClientLike } from '@server/shared/types/actors';

export interface FolderDocument {
    id?: string;
    _id?: string;
    name?: string;
    type?: string | null;
    folder?: string | null;
    parent?: string | null;
    sorting?: 'a' | 'm';
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
export interface JournalEntryPageDocument {
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

export interface JournalEntryDocument {
    id?: string;
    _id?: string;
    name?: string;
    folder?: string | null;
    ownership?: Record<string, number>;
    pages?: JournalEntryPageDocument[];
    flags?: Record<string, unknown>;
    _stats?: Record<string, unknown>;
    sort?: number;
    [key: string]: unknown;
}

export interface ChatMessageDocument {
    id?: string;
    _id?: string;
    content?: string;
    timestamp?: number;
    [key: string]: unknown;
}

export interface CombatantDocument {
    id?: string;
    _id?: string;
    name?: string;
    img?: string | null;
    actorId?: string;
    tokenId?: string;
    sceneId?: string | null;
    hidden?: boolean;
    defeated?: boolean;
    initiative?: number | null;
    group?: string | null;
    type?: string;
    system?: Record<string, unknown>;
    flags?: Record<string, unknown>;
    _stats?: Record<string, unknown>;
    [key: string]: unknown;
}

/**
 * Embedded CombatantGroup in Foundry v13 and v14. Combatants reference their
 * group via `CombatantDocument.group`; the parent combat mirrors the group set
 * in `groups[]` the same way `combatants[]` mirrors Combatant children.
 */
export interface CombatantGroupDocument {
    id?: string;
    _id?: string;
    name?: string;
    img?: string | null;
    type?: string;
    initiative?: number | null;
    ownership?: Record<string, number>;
    system?: Record<string, unknown>;
    flags?: Record<string, unknown>;
    _stats?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface CombatDocument {
    id?: string;
    _id?: string;
    active?: boolean;
    type?: string;
    scene?: string | null;
    groups?: CombatantGroupDocument[];
    round?: number;
    // Foundry sends `null` for pre-start combats.
    turn?: number | null;
    sort?: number;
    combatants?: CombatantDocument[];
    system?: Record<string, unknown>;
    flags?: Record<string, unknown>;
    _stats?: Record<string, unknown>;
    [key: string]: unknown;
}

/**
 * Embedded RollTable result. `drawn: boolean` is mutable runtime state and
 * the most common update target; embedded handler maintains the `results[]`
 * array in place when these change.
 */
export interface RollTableResultDocument {
    id?: string;
    _id?: string;
    type?: string | number;
    text?: string;
    img?: string | null;
    weight?: number;
    range?: [number, number];
    drawn?: boolean;
    documentCollection?: string;
    documentId?: string | null;
    flags?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface RollTableDocument {
    id?: string;
    _id?: string;
    name?: string;
    img?: string | null;
    description?: string;
    folder?: string | null;
    sort?: number;
    formula?: string;
    replacement?: boolean;
    displayRoll?: boolean;
    results?: RollTableResultDocument[];
    ownership?: Record<string, number>;
    flags?: Record<string, unknown>;
    _stats?: Record<string, unknown>;
    [key: string]: unknown;
}

/**
 * Embedded PlaylistSound. Playback state (`playing`, `pausedTime`, `repeat`)
 * is mutable runtime state; embedded handler maintains the `sounds[]` array
 * in place when these change.
 */
export interface PlaylistSoundDocument {
    id?: string;
    _id?: string;
    name?: string;
    path?: string;
    description?: string;
    channel?: string;
    playing?: boolean;
    pausedTime?: number | null;
    repeat?: boolean;
    volume?: number;
    fade?: number | null;
    sort?: number;
    flags?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface PlaylistDocument {
    id?: string;
    _id?: string;
    name?: string;
    description?: string;
    mode?: number;
    playing?: boolean;
    fade?: number | null;
    folder?: string | null;
    sort?: number;
    seed?: number;
    channel?: string;
    sounds?: PlaylistSoundDocument[];
    ownership?: Record<string, number>;
    flags?: Record<string, unknown>;
    _stats?: Record<string, unknown>;
    [key: string]: unknown;
}

/**
 * Embedded Card record. Carries Foundry card fields without modeling
 * game-specific semantics (Sheet Delver doesn't currently use cards).
 */
export interface CardDocument {
    id?: string;
    _id?: string;
    name?: string;
    description?: string;
    type?: string;
    faces?: Array<{ name?: string; img?: string; text?: string; [key: string]: unknown }>;
    face?: number | null;
    drawn?: boolean;
    suit?: string;
    value?: number | null;
    origin?: string | null;
    back?: { name?: string; img?: string; text?: string; [key: string]: unknown };
    width?: number;
    height?: number;
    rotation?: number;
    sort?: number;
    flags?: Record<string, unknown>;
    system?: Record<string, unknown>;
    _stats?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface CardsDocument {
    id?: string;
    _id?: string;
    name?: string;
    type?: 'deck' | 'hand' | 'pile' | string;
    description?: string;
    img?: string | null;
    cards?: CardDocument[];
    displayCount?: boolean;
    folder?: string | null;
    sort?: number;
    width?: number;
    height?: number;
    rotation?: number;
    ownership?: Record<string, number>;
    flags?: Record<string, unknown>;
    system?: Record<string, unknown>;
    _stats?: Record<string, unknown>;
    [key: string]: unknown;
}

/**
 * Foundry Macro primary doc. `author` is creator attribution metadata —
 * NOT part of ownership resolution; access is gated through the `ownership`
 * map exactly like every other standard-map type (see ADR-0011 Phase 7).
 */
export interface MacroDocument {
    id?: string;
    _id?: string;
    name?: string;
    type?: 'script' | 'chat' | string;
    author?: string;
    img?: string | null;
    scope?: 'global' | 'actor' | 'actors' | string;
    command?: string;
    folder?: string | null;
    sort?: number;
    ownership?: Record<string, number>;
    flags?: Record<string, unknown>;
    _stats?: Record<string, unknown>;
    [key: string]: unknown;
}

/**
 * Remaining Phase 7 document shapes. Scene is now actively mirrored for
 * internal combat projection; FogExploration and Adventure remain unwired.
 */
/**
 * Embedded ActorDelta on a Token (Foundry v13/v14). For unlinked tokens the
 * synthetic token actor is the base actor merged with this delta; status
 * effects applied to the token land in `effects[]` here, not on the base
 * actor document.
 */
export interface ActorDeltaDocument {
    id?: string;
    _id?: string;
    name?: string | null;
    type?: string | null;
    img?: string | null;
    system?: Record<string, unknown> | null;
    items?: unknown[];
    effects?: unknown[];
    ownership?: Record<string, number> | null;
    flags?: Record<string, unknown>;
    [key: string]: unknown;
}

/** Embedded Token document on a Scene (Foundry v13/v14). */
export interface TokenDocument {
    id?: string;
    _id?: string;
    name?: string;
    actorId?: string | null;
    actorLink?: boolean;
    hidden?: boolean;
    texture?: {
        src?: string | null;
        [key: string]: unknown;
    };
    delta?: ActorDeltaDocument | null;
    [key: string]: unknown;
}

export interface SceneDocument {
    id?: string;
    _id?: string;
    name?: string;
    active?: boolean;
    ownership?: Record<string, number>;
    tokens?: TokenDocument[];
    [key: string]: unknown;
}
export interface FogExplorationDocument {
    id?: string;
    _id?: string;
    user?: string;
    scene?: string;
    [key: string]: unknown;
}
export interface AdventureDocument {
    id?: string;
    _id?: string;
    name?: string;
    [key: string]: unknown;
}
export interface SettingDocument {
    id?: string;
    _id?: string;
    key?: string;
    value?: unknown;
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
    getActor(actorId: string): Promise<(ActorDocument & { error?: string }) | null | undefined>;
    dispatchDocument(
        type: string,
        action: string,
        operation?: unknown,
        parent?: { type: string; id: string }
    ): Promise<unknown>;
    roll(
        formula: string,
        label: string,
        options?: { speaker?: { actor?: string; alias?: string } }
    ): Promise<RollChatMessageLike>;
}
