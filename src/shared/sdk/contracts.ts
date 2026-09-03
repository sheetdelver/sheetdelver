import type { SystemComponentStyles, SystemThemeColors } from './interfaces';

/**
 * Standard user information for platform-wide status.
 */
export interface StatusUser {
    _id: string;
    name: string;
    role: number;
    isGM: boolean;
    active: boolean;
    color?: string;
    characterId?: string | null;
    characterName?: string | null;
    img?: string;
}

/** Minimum roster entry exposed before Foundry authentication. */
export interface PublicStatusUser {
    name: string;
    active: boolean;
    canLogin: boolean;
}

export type FoundryCompatibilityStatus =
    | 'supported'
    | 'newer-untested'
    | 'unknown'
    | 'unsupported';

export interface FoundryCompatibilityStatusPayload {
    status: FoundryCompatibilityStatus;
    generation: number | null;
    minGeneration: number;
    maxGeneration: number;
    message: string;
    checkedAt: number;
}

/**
 * Payload for system-wide status updates.
 */
export interface SystemStatusPayload {
    connected: boolean;
    worldId: string | null;
    initialized: boolean;
    isConfigured: boolean;
    foundryCompatibility: FoundryCompatibilityStatusPayload | null;
    users: StatusUser[];
    system: {
        id: string | null;
        title?: string;
        version?: string;
        appVersion?: string;
        worldTitle?: string;
        worldDescription?: string | null;
        worldBackground?: string;
        background?: string;
        nextSession?: string | null;
        status?: string;
        theme?: SystemThemeColors;
        componentStyles?: SystemComponentStyles;
        actorSyncToken?: string;
        users?: { active: number; total: number };
        config?: Record<string, unknown>;
        [key: string]: unknown;
    };
    url: string;
    appVersion: string;
    debug: {
        enabled: boolean;
        level: number;
    };
}

/** Guest-safe availability projection used by REST and realtime status. */
export interface PublicStatusPayload {
    connected: boolean;
    initialized: boolean;
    isConfigured: boolean;
    foundryCompatibility: FoundryCompatibilityStatusPayload | null;
    users: PublicStatusUser[];
    system: {
        id: string | null;
        title?: string;
        version?: string;
        worldTitle?: string;
        worldDescription?: string | null;
        worldBackground?: string;
        background?: string;
        nextSession?: string | null;
        status?: string;
        users?: { active: number; total: number };
        theme?: SystemThemeColors;
        componentStyles?: SystemComponentStyles;
    };
    appVersion: string;
    worldId?: never;
    url?: never;
    debug?: never;
}

/**
 * Authenticated status payload, including session-specific info.
 */
export interface AuthenticatedStatusPayload extends SystemStatusPayload {
    isAuthenticated: boolean;
    currentUserId: string | null;
}

export type StatusResponsePayload =
    | (PublicStatusPayload & { isAuthenticated: false; currentUserId: null })
    | AuthenticatedStatusPayload;

export type RealtimeStatusPayload = PublicStatusPayload | SystemStatusPayload;

/**
 * Payload for realtime actor updates. Consumers should refetch the affected actor/card.
 */
export interface RealtimeActorChangedPayload {
    actorId: string;
    action: 'create' | 'update' | 'delete';
}

/**
 * Payload for realtime content sharing (images, journals).
 */
export interface RealtimeSharedContentPayload {
    type: 'image' | 'journal' | null;
    data?: {
        url?: string;
        title?: string;
        id?: string;
        uuid?: string;
        [key: string]: unknown;
    };
    timestamp: number;
}

/** Combatant information for realtime updates. */
export interface StatusCombatant {
    _id: string;
    actorId: string;
    tokenId: string;
    sceneId: string;
    name: string;
    img: string | null;
    initiative: number | null;
    defeated: boolean;
    hidden: boolean;
    type: string;
    system: Record<string, unknown>;
    [key: string]: unknown;
}

/** Payload for realtime combat document changes (skinny invalidation hint). */
export interface RealtimeCombatChangedPayload {
    combatId: string;
    action: 'create' | 'update' | 'delete';
}
/** Payload for realtime combat list invalidations (ownership/visibility crossings). */
export interface RealtimeCombatListInvalidatedPayload {
    reason: string;
    combatId?: string;
}

/** Payload for realtime world Item document changes (skinny invalidation hint). */
export interface RealtimeItemChangedPayload {
    itemId: string;
    action: 'create' | 'update' | 'delete';
}
/** Payload for realtime world Item list invalidations. */
export interface RealtimeItemListInvalidatedPayload {
    reason: string;
    itemId?: string;
}

/** Payload for realtime RollTable document changes (Phase 7). */
export interface RealtimeRollTableChangedPayload {
    rollTableId: string;
    action: 'create' | 'update' | 'delete';
}
/** Payload for realtime RollTable list invalidations (Phase 7). */
export interface RealtimeRollTableListInvalidatedPayload {
    reason: string;
    rollTableId?: string;
}

/** Payload for realtime Macro document changes (Phase 7). */
export interface RealtimeMacroChangedPayload {
    macroId: string;
    action: 'create' | 'update' | 'delete';
}
/** Payload for realtime Macro list invalidations (Phase 7). */
export interface RealtimeMacroListInvalidatedPayload {
    reason: string;
    macroId?: string;
}

/** Payload for realtime Playlist document changes (Phase 7). */
export interface RealtimePlaylistChangedPayload {
    playlistId: string;
    action: 'create' | 'update' | 'delete';
}
/** Payload for realtime Playlist list invalidations (Phase 7). */
export interface RealtimePlaylistListInvalidatedPayload {
    reason: string;
    playlistId?: string;
}

/** Payload for realtime Cards document changes (Phase 7). */
export interface RealtimeCardsChangedPayload {
    cardsId: string;
    action: 'create' | 'update' | 'delete';
}
/** Payload for realtime Cards list invalidations (Phase 7). */
export interface RealtimeCardsListInvalidatedPayload {
    reason: string;
    cardsId?: string;
}

/**
 * ChatMessage represents a message result returned from a Foundry interaction.
 */
export interface ChatMessage {
    /** The unique ID of the message in Foundry. */
    id: string;
    /** The HTML content of the message. */
    content: string;
    /** Any roll data associated with the message. */
    rolls?: unknown[];
    /** Creation timestamp. */
    timestamp: number;
    /** The user ID who created the message. */
    user: string;
    /** Information about the 'speaker' (actor/alias/token) of the message. */
    speaker?: {
        actor?: string;
        alias?: string;
        token?: string;
        scene?: string;
    };
    /** Roll specific metadata. */
    isRoll?: boolean;
    rollTotal?: number;
    rollFormula?: string;
    flavor?: string;
    /** Additional Foundry-specific metadata. */
    [key: string]: unknown;
}

// ModuleFoundryClient was removed (ADR-0027). Module document/roll/table access is
// on req.runtime (server) backed by core; the broad client is no longer a module API.


/**
 * ModuleApiRequest is the standard Request object passed to module API handlers.
 */
export type ModuleApiRequest = Request;

/**
 * ModuleApiParams represents the parsed route parameters for a module API request.
 */
export interface ModuleApiParams {
    /** The parsed route segments. */
    route: string[];
    /** The parsed parameters from the route template. */
    [key: string]: unknown;
}

/**
 * UserSession represents the minimal identity of the user making a request.
 */
export interface UserSession {
    /** The unique user ID in the platform. */
    userId: string;
    /** The display name of the user. */
    username: string;
    /** Whether the user has GM status in the current world. */
    isGM: boolean;
    /** The numerical role of the user (1=Player, 3=GM, etc.). */
    role: number;
}
