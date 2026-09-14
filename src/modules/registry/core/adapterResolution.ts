/**
 * Adapter resolution — JIT-loads logic adapters for discovered modules,
 * provides a generic fallback when no system match is found, and exposes
 * the server-side helpers that route module logic by `systemId`.
 *
 * Per ADR-0022 Phase 3, this was carved out of the monolithic `server.ts`.
 * State lives in `./state`; cross-cutting private helpers live in
 * `./internals`. Bootstrap and fallback adapter ownership live in dedicated
 * registry modules to avoid satellite imports back through `./server`.
 */
import { logger } from '@shared/utils/logger';
import type { SystemAdapter } from './types';
import {
    pluginMap,
    adapterInstances,
    lifecycleStore,
    isInitialized,
} from './state';
import {
    isModuleEnabledForRuntime,
    getLifecycleStateFilePathOverride,
} from './internals';
import {
    recordLifecycleRuntimeFailure,
    saveLifecycleStore,
} from '../lifecycle/lifecycle';

import { initializeRegistry } from './bootstrap';
import { FALLBACK_ADAPTER } from './fallbackAdapter';
import { parseModuleId } from '@shared/security/moduleId';

/**
 * JIT Logic Adapter Loader
 * Loads and instantiates the Logic Adapter for a given systemId.
 */
export async function getAdapter(systemId: string): Promise<SystemAdapter | null> {
    const id = parseModuleId(systemId);
    if (!id) return FALLBACK_ADAPTER;

    if (!isModuleEnabledForRuntime(id) && pluginMap.has(id)) {
        logger.warn(`Registry | Module ${id} is disabled or unavailable due to lifecycle state`);
        // Disabled module code must not execute, but core actor/combat reads can
        // continue through the internal adapter instead of becoming HTTP 500s.
        return FALLBACK_ADAPTER;
    }

    // Ensure discovery has run
    if (!isInitialized()) initializeRegistry();

    const plugin = pluginMap.get(id);
    if (!plugin) {
        // No matching plugin — return the internal fallback adapter
        if (!adapterInstances.has('generic')) adapterInstances.set('generic', FALLBACK_ADAPTER);
        return FALLBACK_ADAPTER;
    }

    if (adapterInstances.has(id)) {
        return adapterInstances.get(id)!;
    }

    const pluginId = parseModuleId(plugin.info.id)!;
    if (!isModuleEnabledForRuntime(pluginId)) {
        logger.warn(`Registry | Refusing to instantiate disabled/incompatible module ${pluginId}`);
        return FALLBACK_ADAPTER;
    }

    try {
        const logicModule = await plugin.getLogic();
        const AdapterClass = logicModule.Adapter || logicModule.default;

        if (!AdapterClass) {
            logger.error(`Registry | No Adapter class found for ${id}`);
            recordLifecycleRuntimeFailure(lifecycleStore, pluginId, 'No Adapter class found in logic module export');
            saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
            return FALLBACK_ADAPTER;
        }

        // Registry resolution only imports and instantiates adapters. WorldBootstrapper
        // owns runtime initialization after compendium hydration and document seeding.
        const adapter = new AdapterClass();

        adapterInstances.set(id, adapter);
        return adapter;
    } catch (e) {
        logger.error(`Registry | Failed to JIT load adapter for ${id}:`, e);
        const message = e instanceof Error ? e.message : 'Unknown adapter load error';
        recordLifecycleRuntimeFailure(lifecycleStore, pluginId, message);
        saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
        // The failure remains visible and disables this source, while the
        // current request can still use core's non-module projection behavior.
        return FALLBACK_ADAPTER;
    }
}

/**
 * JIT Server-Side API Loader
 * Loads specialized server-side routes or handlers for a system.
 */
export async function getServerModule(systemId: string) {
    if (!isInitialized()) initializeRegistry();

    const id = parseModuleId(systemId);
    if (!id) return null;
    const plugin = pluginMap.get(id);
    if (!plugin || !plugin.getServer) return null;
    if (!isModuleEnabledForRuntime(id)) {
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
        const id = parseModuleId(systemId);
        if (!id) return;
        logger.info(`Registry | Unloading modules for ${id}`);
        adapterInstances.delete(id);
    } else {
        logger.info('Registry | Purging all active module instances');
        adapterInstances.clear();
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
