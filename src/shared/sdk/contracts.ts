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

/**
 * Payload for system-wide status updates.
 */
export interface SystemStatusPayload {
    connected: boolean;
    worldId: string | null;
    initialized: boolean;
    isConfigured: boolean;
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

/**
 * Authenticated status payload, including session-specific info.
 */
export interface AuthenticatedStatusPayload extends SystemStatusPayload {
    isAuthenticated: boolean;
    currentUserId: string | null;
}

/**
 * Payload for realtime actor updates.
 */
export interface RealtimeActorUpdatePayload {
    actorId: string;
    updates: Record<string, unknown>;
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

/** Payload for realtime combat updates. */
export interface RealtimeCombatUpdatePayload {
    _id: string;
    active: boolean;
    round: number;
    turn: number;
    combatants: StatusCombatant[];
    sceneId: string | null;
    [key: string]: unknown;
}

/** Payload for realtime chat updates. */
export interface RealtimeChatUpdatePayload {
    id: string;
    user: string;
    content: string;
    timestamp: number;
    isRoll?: boolean;
    rollTotal?: number;
    rollFormula?: string;
    flavor?: string;
    [key: string]: unknown;
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

/**
 * ModuleFoundryClient defines the interface for modules to interact with the Foundry backend.
 * All methods are pre-authenticated by the platform and scoped to the user's permissions.
 * FoundryClient is kept as an alias for backwards compatibility.
 */
export interface ModuleFoundryClient {
    /** Whether the client has an active connection to the Foundry server. */
    isConnected: boolean;

    /** Perform a dice roll in Foundry. */
    roll(formula: string, label?: string, options?: { displayChat?: boolean; [key: string]: unknown }): Promise<ChatMessage>;
    
    /** Send a chat message to the Foundry world. */
    sendMessage(data: { content: string; [key: string]: unknown }, options?: { rollMode?: string; speaker?: unknown }): Promise<ChatMessage>;
    
    /** Trigger the 'use' action for an item on an actor. */
    useItem(actorId: string, itemId: string): Promise<ChatMessage | unknown>;

    // --- Actor CRUD ---

    /** Retrieve raw actor data by ID. */
    getActor(id: string): Promise<Record<string, unknown>>;

    /** Retrieve all actors in the current world. */
    getActors(): Promise<Record<string, unknown>[]>;

    /** Create a new actor in the world. */
    createActor(actorData: Record<string, unknown>): Promise<Record<string, unknown>>;

    /** Update actor data. */
    updateActor(id: string, updates: Record<string, unknown>): Promise<Record<string, unknown>>;

    /** Delete an actor from the world. */
    deleteActor(actorId: string): Promise<void>;

    // --- Actor Item CRUD ---

    /** Create a new item on an existing actor. */
    createActorItem(actorId: string, itemData: Record<string, unknown>): Promise<Record<string, unknown>>;

    /** Update an existing item on an actor. */
    updateActorItem(actorId: string, itemData: Record<string, unknown>): Promise<Record<string, unknown>>;

    /** Delete an item from an actor. */
    deleteActorItem(actorId: string, itemId: string): Promise<void>;

    // --- Actor Active Effect CRUD ---

    /** Create an active effect on an actor. */
    createActorEffect(actorId: string, effectData: Record<string, unknown>): Promise<Record<string, unknown>>;

    /** Update an active effect on an actor. */
    updateActorEffect(actorId: string, effectId: string, updates: Record<string, unknown>): Promise<Record<string, unknown>>;

    /** Delete an active effect from an actor. */
    deleteActorEffect(actorId: string, effectId: string): Promise<void>;

    // --- Item Active Effect operations (effects on an actor's item) ---

    /** Update an active effect on one of an actor's items. */
    updateItemEffect(actorId: string, itemId: string, effectId: string, updates: Record<string, unknown>): Promise<Record<string, unknown>>;

    /** Delete an active effect from one of an actor's items. */
    deleteItemEffect(actorId: string, itemId: string, effectId: string): Promise<void>;

    // --- World document access ---

    /** Fetch a document from Foundry using its UUID. */
    fetchByUuid(uuid: string): Promise<Record<string, unknown>>;

    /**
     * Fetch items from the active world (non-compendium).
     * Use the compendium cache via context.platform.discovery for indexed pack data.
     * This is for world-owned items that are not in a compendium.
     */
    getWorldItems(options?: { type?: string }): Promise<Record<string, unknown>[]>;
    
    /**
     * Fetch a RollTable document by UUID and simulate a draw from it.
     * Returns a standardized DrawResult with roll value, matched results, and resolved items.
     */
    drawTable(tableId: string, options?: { rollOverride?: number }): Promise<import('./utils').DrawResult>;

    /** Resolve a relative path to a full URL (handling platform base paths). */
    resolveUrl(path: string): string;

    /** Get the current Foundry system id (e.g. 'shadowdark'). */
    getSystemId(): Promise<string>;
}

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

/** @deprecated Use ModuleFoundryClient instead. */
export type FoundryClient = ModuleFoundryClient;
