/**
 * Adapter resolution — JIT-loads logic adapters for discovered modules,
 * provides a generic fallback when no system match is found, and exposes
 * the server-side helpers that route module logic by `systemId`.
 *
 * Per ADR-0022 Phase 3, this was carved out of the monolithic `server.ts`.
 * State lives in `./state`; cross-cutting private helpers live in
 * `./internals`. `initializeRegistry` and `FALLBACK_ADAPTER` are owned by
 * `./server` so that orchestration stays in one place; we import them here.
 */
import path from 'node:path';
import { logger } from '@shared/utils/logger';
import { hasInitialize, type SystemAdapter } from './types';
import {
    pluginMap,
    adapterInstances,
    adapterMtimes,
    lifecycleStore,
    isInitialized,
    IS_DEV,
} from './state';
import {
    resolveLogicPath,
    getLogicMtime,
    isModuleEnabledForRuntime,
    getLifecycleStateFilePathOverride,
} from './internals';
import {
    recordLifecycleRuntimeFailure,
    saveLifecycleStore,
} from '../lifecycle/lifecycle';

// initializeRegistry and FALLBACK_ADAPTER live in server.ts; we import them
// lazily-callable here. Circular-import is safe because both are used inside
// function bodies, not at module evaluation time.
import { initializeRegistry, FALLBACK_ADAPTER } from './server';

/**
 * JIT Logic Adapter Loader
 * Loads and instantiates the Logic Adapter for a given systemId.
 */
export async function getAdapter(systemId: string): Promise<SystemAdapter | null> {
    const id = systemId.toLowerCase();

    if (!isModuleEnabledForRuntime(id) && pluginMap.has(id)) {
        logger.warn(`Registry | Module ${id} is disabled or unavailable due to lifecycle state`);
        return null;
    }

    // Ensure discovery has run
    if (!isInitialized()) initializeRegistry();

    const plugin = pluginMap.get(id);
    if (!plugin) {
        // No matching plugin — return the internal fallback adapter
        if (!adapterInstances.has('generic')) adapterInstances.set('generic', FALLBACK_ADAPTER);
        return FALLBACK_ADAPTER;
    }

    // In dev mode, check whether the adapter file has changed since it was last loaded.
    // If so, evict the cached instance so we re-import with the new code.
    if (IS_DEV && adapterInstances.has(id)) {
        const currentMtime = getLogicMtime(plugin);
        if (currentMtime && currentMtime !== adapterMtimes.get(id)) {
            logger.info(`Registry | Dev hot-reload: adapter ${id} changed, evicting cache`);
            adapterInstances.delete(id);
            adapterMtimes.delete(id);
        } else {
            return adapterInstances.get(id)!;
        }
    } else if (adapterInstances.has(id)) {
        return adapterInstances.get(id)!;
    }

    const pluginId = plugin.info.id.toLowerCase();
    if (!isModuleEnabledForRuntime(pluginId)) {
        logger.warn(`Registry | Refusing to instantiate disabled/incompatible module ${pluginId}`);
        return null;
    }

    try {
        // In dev mode, use a mtime-stamped URL so the ESM module cache is bypassed when
        // the file changes. The query parameter makes each version a distinct cache entry.
        let logicModule: any;
        if (IS_DEV) {
            const { pathToFileURL } = await import('node:url');
            const logicBase = path.join(plugin.directory, plugin.info.manifest.logic);
            const resolved = resolveLogicPath(logicBase);
            const mtime = getLogicMtime(plugin);
            const url = pathToFileURL(resolved).href + (mtime ? `?v=${mtime}` : '');
            logicModule = await import(url);
        } else {
            logicModule = await plugin.getLogic();
        }
        const AdapterClass = logicModule.Adapter || logicModule.default;

        if (!AdapterClass) {
            logger.error(`Registry | No Adapter class found for ${id}`);
            recordLifecycleRuntimeFailure(lifecycleStore, pluginId, 'No Adapter class found in logic module export');
            saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
            return null;
        }

        const adapter = new AdapterClass();

        // Optional initialization hook: inject ModuleContext so adapters have
        // a namespaced logger, scoped cache, and declared compendium pack reader.
        if (hasInitialize(adapter)) {
            const { createModuleContext } = await import('@server/shared/utils/createModuleContext');
            const context = await createModuleContext(pluginId);
            await adapter.initialize(context);
        }

        adapterInstances.set(id, adapter);
        if (IS_DEV) adapterMtimes.set(id, getLogicMtime(plugin));
        return adapter;
    } catch (e) {
        logger.error(`Registry | Failed to JIT load adapter for ${id}:`, e);
        const message = e instanceof Error ? e.message : 'Unknown adapter load error';
        recordLifecycleRuntimeFailure(lifecycleStore, pluginId, message);
        saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
        return null;
    }
}

/**
 * JIT Server-Side API Loader
 * Loads specialized server-side routes or handlers for a system.
 */
export async function getServerModule(systemId: string) {
    if (!isInitialized()) initializeRegistry();

    const plugin = pluginMap.get(systemId.toLowerCase());
    if (!plugin || !plugin.getServer) return null;
    if (!isModuleEnabledForRuntime(systemId.toLowerCase())) {
        logger.warn(`Registry | Refusing to load server module for disabled/incompatible system ${systemId}`);
        return null;
    }

    try {
        return await plugin.getServer();
    } catch (e) {
        logger.error(`Registry | Failed to JIT load server module for ${systemId}:`, e);
        return null;
    }
}

/**
 * Service Lifecycle: Explicitly Unload Modules
 * Clears cached instances for a specific system or all systems.
 */
export function unloadSystemModules(systemId?: string) {
    if (systemId) {
        const id = systemId.toLowerCase();
        logger.info(`Registry | Unloading modules for ${id}`);
        adapterInstances.delete(id);
        adapterMtimes.delete(id);
    } else {
        logger.info('Registry | Purging all active module instances');
        adapterInstances.clear();
        adapterMtimes.clear();
    }
}

/**
 * Asynchronously finds the correct adapter for an actor object based on matching rules.
 */
export async function getMatchingAdapter(actor: any): Promise<SystemAdapter> {
    if (!actor) return FALLBACK_ADAPTER;

    if (actor.systemId) {
        const exact = await getAdapter(actor.systemId);
        if (exact && exact.systemId !== 'generic') return exact;
    }

    if (!isInitialized()) initializeRegistry();

    for (const plugin of pluginMap.values()) {
        const adapter = await getAdapter(plugin.info.id);
        if (adapter && adapter.systemId !== 'generic' && adapter.match(actor)) return adapter;
    }

    return FALLBACK_ADAPTER;
}
