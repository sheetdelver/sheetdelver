import { logger } from '@shared/utils/logger';
import { getConfig } from '@core/config';
import { compendiumStore, type CompendiumStore } from '@server/core/compendium/CompendiumStore';
import {
    SdkError,
    type ModuleLogger,
    type CompendiumPackConfig,
    type CompendiumPackDeclaration,
} from '@shared/sdk';
import type {
    ModuleRuntime,
    DataStore,
    CompendiumPackReader,
} from '@shared/sdk/runtime';
import { requireModuleId } from '@shared/security/moduleId';

/**
 * Sub-namespace under the module's cache dir for DataStore-owned data, kept separate
 * from compendium backing so `keys()` never returns pack shards (ADR-0027).
 */
const DATASTORE_NS = 'datastore';
const RESERVED_DATASTORE_KEYS = new Set(['datastore', 'compendiums', 'manifest']);

export interface CompendiumPackScope {
    systemId: string;
    packs: CompendiumPackDeclaration[];
}

export interface ScopedCompendiumPackDeps {
    packStore?: CompendiumStore;
    getCompendiumPackScope?: (moduleId: string) => Promise<CompendiumPackScope | null> | CompendiumPackScope | null;
}

/**
 * Creates a namespaced logger for a module.
 * Wraps the platform logger with a [module-id] prefix.
 */
function createModuleLogger(moduleId: string): ModuleLogger {
    const prefix = `[module:${moduleId}]`;
    return {
        debug: (message, ...args) => logger.debug(`${prefix} ${message}`, ...args),
        info: (message, ...args) => logger.info(`${prefix} ${message}`, ...args),
        warn: (message, ...args) => logger.warn(`${prefix} ${message}`, ...args),
        error: (message, ...args) => logger.error(`${prefix} ${message}`, ...args),
    };
}

function hasPathCharacters(value: string): boolean {
    return value.includes('/') || value.includes('\\') || value.includes('\0');
}

export function validateDataStoreKey(key: string): string {
    if (!key) throw new SdkError('validation', 'DataStore key cannot be empty');
    if (key === '.' || key === '..') throw new SdkError('validation', `DataStore key is reserved: ${key}`);
    if (hasPathCharacters(key)) throw new SdkError('validation', `DataStore key must be a flat logical name: ${key}`);
    if (RESERVED_DATASTORE_KEYS.has(key.toLowerCase())) {
        throw new SdkError('validation', `DataStore key is reserved: ${key}`);
    }
    return key;
}

export function validateDataStorePrefix(prefix?: string): string | undefined {
    if (prefix === undefined || prefix === '') return undefined;
    if (prefix === '.' || prefix === '..') throw new SdkError('validation', `DataStore key prefix is reserved: ${prefix}`);
    if (hasPathCharacters(prefix)) throw new SdkError('validation', `DataStore key prefix must be flat: ${prefix}`);
    return prefix;
}

/**
 * Creates the module-scoped DataStore, backed by PersistentCache under
 * `<moduleId>/datastore/` so module-owned data cannot collide with compendium backing
 * and `keys()` only sees module data. The module id namespaces it so modules cannot
 * read each other's data. Keys are validated here because PersistentCache is a
 * general-purpose internal utility and does not enforce the SDK's flat-key contract.
 */
async function createScopedDataStore(moduleId: string): Promise<DataStore> {
    const { PersistentCache } = await import('@core/cache/PersistentCache');
    const cache = PersistentCache.getInstance();
    const ns = `${moduleId}/${DATASTORE_NS}`;
    return {
        get: <T>(key: string) => cache.get<T>(ns, validateDataStoreKey(key)),
        set: <T>(key: string, value: T) => cache.set<T>(ns, validateDataStoreKey(key), value),
        delete: (key: string) => cache.delete(ns, validateDataStoreKey(key)),
        has: (key: string) => cache.has(ns, validateDataStoreKey(key)),
        keys: (prefix?: string) => cache.keys(ns, validateDataStorePrefix(prefix)),
    };
}

/**
 * Resolve the module-declared pack scope that is allowed to back
 * `runtime.compendium`. No scope means pack reads fail closed.
 */
async function resolveCompendiumPackScope(moduleId: string): Promise<CompendiumPackScope | null> {
    const canonicalId = requireModuleId(moduleId);
    const { getModuleCompendiumPackConfig } = await import('@modules/registry/server');
    const config = getModuleCompendiumPackConfig(canonicalId) as CompendiumPackConfig | undefined;
    if (!config?.packs?.length) return null;
    return {
        systemId: canonicalId,
        packs: config.packs,
    };
}

function getScopedPackIds(scope: CompendiumPackScope | null, type: string): string[] {
    if (!scope) return [];
    return scope.packs
        .filter(pack => pack.type === type)
        .map(pack => pack.id);
}

/**
 * The module-facing compendium read surface (ADR-0027 decision 11).
 *
 * Declaration in `info.json` `compendiumPacks` is **hydration intent, not an access gate**.
 * The fail-closed rule is only that an unknown read (a pack not present in the compendium
 * at all) resolves to null and never triggers a live Foundry fetch — satisfied by
 * construction, since the reader only ever touches the offline `CompendiumStore`.
 *
 * Reads are bounded by the module's *system* (cross-system isolation). Within it:
 *  - query reads (`findOne`/`findAll`) are scoped to the declared packs of the requested
 *    `type` — not as an access gate, but because the declaration is the reader's
 *    authoritative type→pack map (the Store's row query is type-agnostic);
 *  - `getById` with a fully-qualified `Compendium.<pack>.<Type>.<id>` UUID names its own
 *    pack, so declaration is not consulted: any pack *present* in the system resolves
 *    (an undeclared-but-present pack is readable), and an absent one returns null offline.
 */
export async function createScopedCompendiumPacks(
    moduleId: string,
    deps: ScopedCompendiumPackDeps = {},
): Promise<CompendiumPackReader> {
    const canonicalId = requireModuleId(moduleId);
    const packStore = deps.packStore || compendiumStore;
    const scope = deps.getCompendiumPackScope
        ? await deps.getCompendiumPackScope(canonicalId)
        : await resolveCompendiumPackScope(canonicalId);

    const systemId = scope?.systemId ?? canonicalId;

    return {
        findOne: async (type: string, query: Record<string, unknown>) => {
            const packIds = getScopedPackIds(scope, type);
            if (packIds.length === 0) return null;
            return packStore.findOne(systemId, type, query, { packIds });
        },
        findAll: async (type: string, query?: Record<string, unknown>) => {
            const packIds = getScopedPackIds(scope, type);
            if (packIds.length === 0) return [];
            return packStore.findAll(systemId, type, query || {}, { packIds });
        },
        getById: async (type: string, id: string) => {
            // Fully-qualified UUID names its own pack — declaration is not an access gate
            // (decision 11): resolve any present pack in the system, offline.
            if (id.startsWith('Compendium.')) {
                return packStore.getById(systemId, type, id);
            }
            // Bare id: type-scope to declared packs (the reader's authoritative type map).
            const packIds = getScopedPackIds(scope, type);
            if (packIds.length === 0) return null;
            return packStore.getById(systemId, type, id, { packIds });
        },
    };
}

/**
 * Builds a ModuleRuntime for a given module id.
 * Called by the registry when initializing an adapter.
 */
export async function createModuleRuntime(moduleId: string): Promise<ModuleRuntime> {
    const canonicalId = requireModuleId(moduleId);
    const [dataStore, compendium] = await Promise.all([
        createScopedDataStore(canonicalId),
        createScopedCompendiumPacks(canonicalId),
    ]);

    let foundryUrl = '';
    try {
        foundryUrl = getConfig().foundry.url;
    } catch {
        // config not yet loaded — adapter will get an empty string
    }

    const [{ createReadonlyDocumentStore }, { DocumentResolver }] = await Promise.all([
        import('@server/shared/utils/moduleDocumentServices'),
        import('@server/services/documents'),
    ]);
    const documentResolver = new DocumentResolver({ allowLiveCompendiumUuidFallback: false });

    return {
        moduleId: canonicalId,
        logger: createModuleLogger(moduleId),
        foundryUrl,
        dataStore,
        compendium,
        // Adapters are read-only (ADR-0027 decision 14). Base reads are system-level;
        // UUID resolution uses the Store-backed resolver with no live compendium fetch fallback.
        documents: createReadonlyDocumentStore({
            fetchByUuid: async (uuid) => (await documentResolver.fetchByUuid(uuid)) as Record<string, unknown> | null,
        }),
    };
}
