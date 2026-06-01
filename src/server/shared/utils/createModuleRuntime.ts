import { logger } from '@shared/utils/logger';
import { getConfig } from '@core/config';
import { compendiumStore, type CompendiumStore } from '@server/core/compendium/CompendiumStore';
import type {
    ModuleRuntime,
    ModuleLogger,
    DataStore,
    CompendiumPackReader,
    CompendiumPackConfig,
    CompendiumPackDeclaration,
} from '@shared/sdk';

/**
 * Sub-namespace under the module's cache dir for DataStore-owned data, kept separate
 * from compendium backing so `keys()` never returns pack shards (ADR-0027).
 */
const DATASTORE_NS = 'datastore';

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

/**
 * Creates the module-scoped DataStore, backed by PersistentCache under
 * `<moduleId>/datastore/` so module-owned data cannot collide with compendium backing
 * and `keys()` only sees module data. The module id namespaces it so modules cannot
 * read each other's data.
 */
async function createScopedDataStore(moduleId: string): Promise<DataStore> {
    const { PersistentCache } = await import('@core/cache/PersistentCache');
    const cache = PersistentCache.getInstance();
    const ns = `${moduleId}/${DATASTORE_NS}`;
    return {
        get: <T>(key: string) => cache.get<T>(ns, key),
        set: <T>(key: string, value: T) => cache.set<T>(ns, key, value),
        delete: (key: string) => cache.delete(ns, key),
        has: (key: string) => cache.has(ns, key),
        keys: (prefix?: string) => cache.keys(ns, prefix),
    };
}

/**
 * Resolve the module-declared pack scope that is allowed to back
 * `runtime.compendium`. No scope means pack reads fail closed.
 */
async function resolveCompendiumPackScope(moduleId: string): Promise<CompendiumPackScope | null> {
    const { getModuleCompendiumPackConfig } = await import('@modules/registry/server');
    const config = getModuleCompendiumPackConfig(moduleId) as CompendiumPackConfig | undefined;
    if (!config?.packs?.length) return null;
    return {
        systemId: moduleId.toLowerCase(),
        packs: config.packs,
    };
}

function parseCompendiumPackId(uuid: string): string | null {
    if (!uuid.startsWith('Compendium.')) return null;
    const parts = uuid.split('.');
    if (parts.length < 4) return null;

    parts.pop();
    const possibleType = parts[parts.length - 1] || '';
    const hasTypeSegment = /^[A-Z]/.test(possibleType);
    return (hasTypeSegment ? parts.slice(1, -1) : parts.slice(1)).join('.') || null;
}

function getScopedPackIds(scope: CompendiumPackScope | null, type: string): string[] {
    if (!scope) return [];
    return scope.packs
        .filter(pack => pack.type === type)
        .map(pack => pack.id);
}

function isScopedUuid(id: string, packIds: readonly string[]): boolean {
    const packId = parseCompendiumPackId(id);
    return Boolean(packId && packIds.includes(packId));
}

export async function createScopedCompendiumPacks(
    moduleId: string,
    deps: ScopedCompendiumPackDeps = {},
): Promise<CompendiumPackReader> {
    const packStore = deps.packStore || compendiumStore;
    const scope = deps.getCompendiumPackScope
        ? await deps.getCompendiumPackScope(moduleId)
        : await resolveCompendiumPackScope(moduleId);

    return {
        findOne: async (type: string, query: Record<string, unknown>) => {
            const packIds = getScopedPackIds(scope, type);
            if (!scope || packIds.length === 0) return null;

            return packStore.findOne(scope.systemId, type, query, { packIds });
        },
        findAll: async (type: string, query?: Record<string, unknown>) => {
            const packIds = getScopedPackIds(scope, type);
            if (!scope || packIds.length === 0) return [];
            return packStore.findAll(scope.systemId, type, query || {}, { packIds });
        },
        getById: async (type: string, id: string) => {
            const packIds = getScopedPackIds(scope, type);
            if (!scope || packIds.length === 0) return null;
            // Bare document ids are safe because the Store call is still scoped
            // to declared pack ids. Fully-qualified UUIDs must name one of those
            // packs before we ask the Store to search.
            if (id.startsWith('Compendium.') && !isScopedUuid(id, packIds)) return null;

            return packStore.getById(scope.systemId, type, id, { packIds });
        },
    };
}

/**
 * Builds a ModuleRuntime for a given module id.
 * Called by the registry when initializing an adapter.
 */
export async function createModuleRuntime(moduleId: string): Promise<ModuleRuntime> {
    const [dataStore, compendium] = await Promise.all([
        createScopedDataStore(moduleId),
        createScopedCompendiumPacks(moduleId),
    ]);

    let foundryUrl = '';
    try {
        foundryUrl = getConfig().foundry.url;
    } catch {
        // config not yet loaded — adapter will get an empty string
    }

    return {
        moduleId,
        logger: createModuleLogger(moduleId),
        foundryUrl,
        dataStore,
        compendium,
    };
}
