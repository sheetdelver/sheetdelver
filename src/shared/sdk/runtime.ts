import { ModuleLogger } from './logging';
import type { DrawResult } from './utils';
import type { ChatCard, RollMode } from './interfaces';

/** Options shared by chat-posting primitives (ADR-0027 decision 7 addendum). */
export interface ChatPostOptions {
    /**
     * Roll mode governing visibility: `publicroll` (all), `gmroll` (whisper GMs),
     * `blindroll` (blind + GMs), `selfroll` (whisper self). The platform resolves it into
     * whisper/blind; any explicit `whisper`/`blind` already on the message overrides it.
     */
    rollMode?: RollMode;
    speaker?: Record<string, unknown>;
}

/** Foundry-style ownership ladder used for read visibility and write thresholds. */
export type ModuleOwnershipLevel = 'limited' | 'observer' | 'owner';

/**
 * Per-operation authorization context (ADR-0027 decision 9). On `req.runtime`,
 * document ops default their acting identity to the calling user (`req.userSession`).
 * Read operations may pass `{ access }` to evaluate visibility as an explicit subject;
 * write operations must match the request's bound Foundry transport user.
 */
export interface ModuleAccessContext {
    userId: string;
    role: number;
    isGM: boolean;
    moduleId: string;
    trustTier?: 'first-party' | 'verified-third-party' | 'unverified';
    permissions?: {
        network?: boolean;
        adminRoutes?: boolean;
        sensitiveData?: string[];
    };
}

/** Optional per-op access context + ownership threshold. Default acting subject = caller. */
export interface DocumentOpOptions {
    access?: ModuleAccessContext;
    minOwnership?: ModuleOwnershipLevel;
}

/** Query shape for `documents.list` (ADR-0027 decision 3). */
export interface DocumentQuery {
    filter?: Record<string, unknown>;
    sort?: string | { field: string; dir?: 'asc' | 'desc' };
    page?: number;
    pageSize?: number;
    limit?: number;
}

export interface DocumentListResult {
    rows: Record<string, unknown>[];
    total: number;
    page?: number;
}

/** Structured server-side roll result (counterpart to the client-side `simulateRoll`). */
export interface RollResult {
    formula: string;
    total: number;
    terms?: unknown[];
    dice?: number[];
    /**
     * The evaluated roll(s) serialized as Foundry `Roll.toJSON()` strings. Attach these to a
     * `chat.card({ rolls })` / `chat.send({ rolls })` message so Foundry registers the roll
     * and animates the dice (e.g. Dice So Nice) even when the roll was evaluated without
     * `displayChat` — the structured result drives the module's own card, these drive the dice.
     */
    rolls?: string[];
    [key: string]: unknown;
}

/**
 * Read surface over the platform's primary document stores, type-keyed. This is the
 * adapter's *entire* document surface (read-only — decision 14) and the read half of a
 * route's `req.runtime.documents`.
 */
export interface ReadonlyDocumentStore {
    list(type: string, query?: DocumentQuery, opts?: DocumentOpOptions): Promise<DocumentListResult>;
    get(type: string, id: string, opts?: DocumentOpOptions): Promise<Record<string, unknown> | null>;
    fetchByUuid(uuid: string, opts?: DocumentOpOptions): Promise<Record<string, unknown> | null>;
}

/**
 * Full document surface — only on a route's `req.runtime` (decision 5/6). Writes default
 * to the calling user and fail closed when ownership/permission is insufficient.
 */
export interface DocumentStore extends ReadonlyDocumentStore {
    create(type: string, data: Record<string, unknown>, opts?: DocumentOpOptions): Promise<Record<string, unknown>>;
    patch(type: string, id: string, updates: Record<string, unknown>, opts?: DocumentOpOptions): Promise<Record<string, unknown>>;
    upsert(type: string, data: Record<string, unknown>, opts?: DocumentOpOptions): Promise<Record<string, unknown>>;
    delete(type: string, id: string, opts?: DocumentOpOptions): Promise<void>;
    /** Batched CRUD in one round-trip; each op is access-checked before dispatch. */
    commit(type: string, ops: Array<Record<string, unknown>>, opts?: DocumentOpOptions): Promise<Record<string, unknown>[]>;
    /**
     * Embedded ActiveEffect mutations. `parent` is addressed by Foundry uuid (`type.id`):
     * a top-level `{ type: 'Actor', id }` / `{ type: 'Item', id }`, or a document owned by
     * another — e.g. an effect on an actor's owned item via `{ type: 'Actor.<actorId>.Item',
     * id: itemId }` (uuid `Actor.<actorId>.Item.<itemId>`). Writes are gated on owner-level
     * access to the ROOT document, so any embedding depth is permitted for documents the
     * caller can write.
     */
    effects: {
        create(parent: { type: string; id: string }, data: Record<string, unknown>, opts?: DocumentOpOptions): Promise<Record<string, unknown>>;
        update(parent: { type: string; id: string }, effectId: string, updates: Record<string, unknown>, opts?: DocumentOpOptions): Promise<Record<string, unknown>>;
        delete(parent: { type: string; id: string }, effectId: string, opts?: DocumentOpOptions): Promise<void>;
    };
    /**
     * Embedded Item mutations on an actor parent (ADR-0027 addendum). Parent-scoped so
     * an actor's owned items can be created/updated/deleted server-side via the runtime —
     * the server counterpart to the client `useDocumentMutation().embedded` surface.
     */
    items: {
        create(parent: { type: string; id: string }, data: Record<string, unknown>, opts?: DocumentOpOptions): Promise<Record<string, unknown>>;
        update(parent: { type: string; id: string }, itemId: string, updates: Record<string, unknown>, opts?: DocumentOpOptions): Promise<Record<string, unknown>>;
        delete(parent: { type: string; id: string }, itemId: string, opts?: DocumentOpOptions): Promise<void>;
    };
}

/**
 * Options for `rolls.roll`. The roll is always evaluated and the structured {@link RollResult}
 * returned; these control whether and how it also posts to Foundry chat.
 */
export interface RollOptions {
    /**
     * Post the roll to Foundry as a real roll message — registering it and triggering the dice
     * animation (e.g. Dice So Nice). Default `false`: the roll is evaluated and returned but
     * nothing is posted, so a module can render its own card and (optionally) pass the result's
     * `rolls` to `chat.card`/`chat.send` to surface the dice. Set `true` for a plain posted roll.
     */
    displayChat?: boolean;
    /** Visibility when posted (decision 7): `publicroll` / `gmroll` / `blindroll` / `selfroll`. */
    rollMode?: RollMode;
    /** Speaker attribution for the posted roll message. */
    speaker?: Record<string, unknown>;
    /** Flags to attach to the posted message. */
    flags?: Record<string, unknown>;
}

/** Dice evaluation primitive (structured result; chat posting is opt-in via {@link RollOptions}). */
export interface RollRuntime {
    roll(formula: string, label?: string, options?: RollOptions): Promise<RollResult>;
}

/** RollTable draw primitive (roll + match). */
export interface TableRuntime {
    draw(uuid: string, options?: { rollOverride?: number }): Promise<DrawResult>;
}

/**
 * Chat primitive (ADR-0027 decision 7 addendum), all user-bound + readiness-gated:
 *  - `send` posts a raw ChatMessage document (the module builds the body);
 *  - `card` posts the structured `ChatCard` render contract (decision 15) — the reusable
 *    "create a chat card" primitive (title/flavor/content/rolls/buttons);
 *  - `useItem` posts the default "uses item" card for an actor's item.
 */
export interface ChatRuntime {
    send(message: Record<string, unknown>, options?: ChatPostOptions): Promise<unknown>;
    card(card: ChatCard, options?: ChatPostOptions): Promise<unknown>;
    useItem(actorId: string, itemId: string, options?: ChatPostOptions): Promise<unknown>;
}

/**
 * DataStore is the module-scoped, durable backend persistence surface (ADR-0027).
 * It is backed by the platform cache under a per-module `datastore/` boundary so
 * `keys()` never returns compendium backing or platform metadata; modules never see
 * or import the underlying `PersistentCache`.
 *
 * For module-owned local data only — preferences, generated indexes, cached
 * computations. It does not reach Foundry, is not the API for compendium reads, and
 * is not a secrets store. Keys are flat logical names.
 */
export interface DataStore {
    /** Retrieve a value. Returns null if not found. */
    get<T>(key: string): Promise<T | null>;
    /** Store a value. */
    set<T>(key: string, value: T): Promise<void>;
    /** Remove a value. */
    delete(key: string): Promise<void>;
    /** Whether a key exists. */
    has(key: string): Promise<boolean>;
    /** List stored keys, optionally filtered by prefix. */
    keys(prefix?: string): Promise<string[]>;
}

/**
 * CompendiumPackReader is the module-scoped read surface for declared packs.
 * It reads the persistent pack rows produced from a module's compendium pack
 * config and fails closed when the module has no declared pack scope.
 */
export interface CompendiumPackReader {
    /** Find a single document matching the given query. */
    findOne(type: string, query: Record<string, unknown>): Promise<Record<string, unknown> | null>;
    /** Find all documents matching the given query. */
    findAll(type: string, query?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
    /** Retrieve a document by its unique identifier. */
    getById(type: string, id: string): Promise<Record<string, unknown> | null>;
}

/**
 * ModuleRuntime is the long-lived, module-scoped server capability handle passed to
 * `adapter.initialize()` (and, once wired, to module route factories). Renamed from
 * `ModuleContext` (ADR-0027) to disambiguate it from the client React context and the
 * per-call access context. The `platform.*` wrapper was flattened: all surfaces sit
 * directly on the runtime.
 *
 * Shared document services (`documents`, `rolls`, `tables`) are added to this handle
 * when the mounted services are wired in (ADR-0027 Phase 1 heavy slice).
 */
export interface ModuleRuntime {
    /** The unique identifier of the module (e.g., 'shadowdark'). */
    moduleId: string;
    /** Namespaced logger for the module. */
    logger: ModuleLogger;
    /** Base URL of the connected Foundry server — use with resolveImage() to build full image URLs. */
    foundryUrl: string;
    /** Durable, module-scoped backend persistence. */
    dataStore: DataStore;
    /** Read surface for the module's declared compendium packs (fail-closed). */
    compendium: CompendiumPackReader;
    /** Read-only document access (get/list/fetchByUuid). Writes are route-only (see ModuleRequestRuntime). */
    documents: ReadonlyDocumentStore;
}

/**
 * ModuleRequestRuntime is the per-request handle a route handler receives as `req.runtime`
 * (ADR-0027 decision 5). It extends the read-only base with user-bound write services;
 * document ops default their acting identity to the calling user (`req.userSession`).
 */
export interface ModuleRequestRuntime extends ModuleRuntime {
    /** Full read + write document surface (CRUD + commit + effects + items), user-bound. */
    documents: DocumentStore;
    /** Dice evaluation primitive. */
    rolls: RollRuntime;
    /** RollTable draw primitive. */
    tables: TableRuntime;
    /** Chat primitive (post a ChatMessage / default item-use card), user-bound. */
    chat: ChatRuntime;
}
