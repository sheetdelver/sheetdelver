import { ModuleLogger } from './logging';

/**
 * PersistentCache defines the interface for module-scoped data persistence.
 * Data is stored on the server and persisted across restarts.
 */
export interface PersistentCache {
    /** Retrieve a value from the cache. Returns null if not found. */
    get<T>(key: string): Promise<T | null>;
    /** Store a value in the cache. */
    set<T>(key: string, value: T): Promise<void>;
    /** Remove a value from the cache. */
    delete(key: string): Promise<void>;
}

/**
 * CompendiumCache defines the interface for document discovery and local caching.
 * This service is used to find and retrieve Foundry documents (Actors, Items, etc.).
 */
export interface CompendiumCache {
    /** Find a single document matching the given query. */
    findOne(type: string, query: Record<string, unknown>): Promise<Record<string, unknown> | null>;
    /** Find all documents matching the given query. */
    findAll(type: string, query?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
    /** Retrieve a document by its unique identifier. */
    getById(type: string, id: string): Promise<Record<string, unknown> | null>;
}

/**
 * ModuleContext is the primary "injection" object passed to external modules
 * when they are initialized by the Core Service. It provides access to platform services.
 */
export interface ModuleContext {
    /** The unique identifier of the module (e.g., 'shadowdark'). */
    moduleId: string;
    /** Namespaced logger for the module. */
    logger: ModuleLogger;
    /** Scoped platform APIs for caching and document discovery. */
    platform: {
        cache: PersistentCache;
        discovery: CompendiumCache;
    };
}
