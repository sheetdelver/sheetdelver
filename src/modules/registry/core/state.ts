/**
 * Shared module-level state for the core registry.
 *
 * The registry holds discovered plugins, instantiated adapters, and the
 * lifecycle store. Behind `globalThis`
 * so dual-loading (CJS + ESM during dev) sees the same instance. Per
 * ADR-0022 Phase 3, the registry's `server.ts` was split across multiple
 * thematic files; they all consume state through this module.
 */
import type { SystemPlugin } from './types';
import {
    createEmptyLifecycleStore,
    type ModuleLifecycleStore,
} from '../lifecycle/lifecycle';

export interface RegistryState {
    pluginMap: Map<string, SystemPlugin>;
    adapterInstances: Map<string, any>;
    isInitialized: boolean;
    lifecycleStore: ModuleLifecycleStore;
}

function getGlobalState(): RegistryState {
    const g = globalThis as any;
    if (!g.__coreRegistry) {
        g.__coreRegistry = {
            pluginMap: new Map<string, SystemPlugin>(),
            adapterInstances: new Map<string, any>(),
            isInitialized: false,
            lifecycleStore: createEmptyLifecycleStore(),
        };
    }
    return g.__coreRegistry;
}

export const registryState: RegistryState = getGlobalState();

export const pluginMap = registryState.pluginMap;
export const adapterInstances = registryState.adapterInstances;
// Keep this object identity stable. Satellites import this const directly, so
// refresh paths must mutate fields in place rather than replacing
// registryState.lifecycleStore.
export const lifecycleStore = registryState.lifecycleStore;

export const isInitialized = (): boolean => registryState.isInitialized;
export const setInitialized = (val: boolean): void => {
    registryState.isInitialized = val;
};

export const getUniquePlugins = (): SystemPlugin[] =>
    Array.from(new Set(pluginMap.values()));
