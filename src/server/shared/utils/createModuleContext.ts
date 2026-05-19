import { logger } from '@shared/utils/logger';
import { getConfig } from '@core/config';
import { CompendiumCache as NameCompendiumCache } from '@core/compendium/CompendiumCache';
import { discoveryShardStore, type DiscoveryShardStore } from '@server/core/compendium/DiscoveryShardStore';
import type {
    ModuleContext,
    ModuleLogger,
    PersistentCache,
    CompendiumCache,
    DiscoveryConfig,
    PackDiscoveryConfig,
} from '@shared/sdk';

export interface DiscoveryScope {
    systemId: string;
    packs: PackDiscoveryConfig[];
}

export interface ScopedDiscoveryDeps {
    shardStore?: DiscoveryShardStore;
    getDiscoveryScope?: (moduleId: string) => Promise<DiscoveryScope | null> | DiscoveryScope | null;
    getNameCache?: () => Pick<NameCompendiumCache, 'getName'>;
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
 * Resolve the module-declared discovery scope that is allowed to back
 * `context.platform.discovery`. No scope means discovery fails closed.
 */
async function resolveDiscoveryScope(moduleId: string): Promise<DiscoveryScope | null> {
    const { getModuleDiscoveryConfig } = await import('@modules/registry/server');
    const discovery = getModuleDiscoveryConfig(moduleId) as DiscoveryConfig | undefined;
    if (!discovery?.packs?.length) return null;
    return {
        systemId: moduleId.toLowerCase(),
        packs: discovery.packs,
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

function getScopedPackIds(scope: DiscoveryScope | null, type: string): string[] {
    if (!scope) return [];
    return scope.packs
        .filter(pack => pack.type === type)
        .map(pack => pack.id);
}

function isScopedUuid(id: string, packIds: readonly string[]): boolean {
    const packId = parseCompendiumPackId(id);
    return Boolean(packId && packIds.includes(packId));
}

export async function createScopedDiscovery(
    moduleId: string,
    deps: ScopedDiscoveryDeps = {},
): Promise<CompendiumCache> {
    const shardStore = deps.shardStore || discoveryShardStore;
    const scope = deps.getDiscoveryScope
        ? await deps.getDiscoveryScope(moduleId)
        : await resolveDiscoveryScope(moduleId);
    const cache = deps.getNameCache ? deps.getNameCache() : NameCompendiumCache.getInstance();

    return {
        findOne: async (type: string, query: Record<string, unknown>) => {
            const packIds = getScopedPackIds(scope, type);
            if (!scope || packIds.length === 0) return null;

            const found = await shardStore.findOne(scope.systemId, type, query, { packIds });
            if (found) return found;

            if (query._id && isScopedUuid(String(query._id), packIds)) {
                const name = cache.getName(String(query._id));
                if (name) return { _id: String(query._id), name };
            }

            return null;
        },
        findAll: async (type: string, query?: Record<string, unknown>) => {
            const packIds = getScopedPackIds(scope, type);
            if (!scope || packIds.length === 0) return [];
            return shardStore.findAll(scope.systemId, type, query || {}, { packIds });
        },
        getById: async (type: string, id: string) => {
            const packIds = getScopedPackIds(scope, type);
            if (!scope || packIds.length === 0) return null;

            const found = await shardStore.getById(scope.systemId, type, id, { packIds });
            if (found) return found;

            if (!isScopedUuid(id, packIds)) return null;
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
