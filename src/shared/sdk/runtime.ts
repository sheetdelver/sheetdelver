import { ModuleLogger } from './logging';

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
}
