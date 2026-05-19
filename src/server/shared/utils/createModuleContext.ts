import { logger } from '@shared/utils/logger';
import { getConfig } from '@core/config';
import type { ModuleContext, ModuleLogger, PersistentCache, CompendiumCache } from '@shared/sdk';

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
 * Creates a namespace-scoped PersistentCache for a module.
 * The module's id is used as the namespace so modules cannot read each other's data.
 */
async function createScopedCache(moduleId: string): Promise<PersistentCache> {
    const { PersistentCache } = await import('@core/cache/PersistentCache');
    const cache = PersistentCache.getInstance();
    return {
        get: <T>(key: string) => cache.get<T>(moduleId, key),
        set: <T>(key: string, value: T) => cache.set<T>(moduleId, key, value),
        delete: (key: string) => cache.delete(moduleId, key),
    };
}

/**
 * Creates a CompendiumCache adapter scoped to a module.
 * Wraps the platform's compendium cache with the SDK's CompendiumCache interface.
 *
 * Note: The platform's internal CompendiumCache is a UUID→name index.
 * findOne/findAll/getById are best-effort lookups within that index.
 */
async function createScopedDiscovery(_moduleId: string): Promise<CompendiumCache> {
    const { CompendiumCache } = await import('@core/compendium/CompendiumCache');
    const cache = CompendiumCache.getInstance();

    return {
        findOne: async (_type: string, query: Record<string, unknown>) => {
            if (query._id) {
                const name = cache.getName(String(query._id));
                if (name) return { _id: String(query._id), name };
            }
            return null;
        },
        findAll: async (_type: string, _query?: Record<string, unknown>) => {
            return [];
        },
        getById: async (_type: string, id: string) => {
            const name = cache.getName(id);
            if (name) return { _id: id, name };
            return null;
        },
    };
}

/**
 * Builds a ModuleContext for a given module id.
 * Called by the registry when initializing an adapter.
 */
export async function createModuleContext(moduleId: string): Promise<ModuleContext> {
    const [scopedCache, scopedDiscovery] = await Promise.all([
        createScopedCache(moduleId),
        createScopedDiscovery(moduleId),
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
        platform: {
            cache: scopedCache,
            discovery: scopedDiscovery,
        },
    };
}
