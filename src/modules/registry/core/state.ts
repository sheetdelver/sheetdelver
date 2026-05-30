/**
 * Shared module-level state for the core registry.
 *
 * The registry holds discovered plugins, instantiated adapters, mtime
 * tracking for dev hot-reload, and the lifecycle store. Behind `globalThis`
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
    adapterMtimes: Map<string, number>;
    isInitialized: boolean;
    lifecycleStore: ModuleLifecycleStore;
}

function getGlobalState(): RegistryState {
    const g = globalThis as any;
    if (!g.__coreRegistry) {
        g.__coreRegistry = {
            pluginMap: new Map<string, SystemPlugin>(),
            adapterInstances: new Map<string, any>(),
            adapterMtimes: new Map<string, number>(),
            isInitialized: false,
            lifecycleStore: createEmptyLifecycleStore(),
        };
    }
    return g.__coreRegistry;
}

export const registryState: RegistryState = getGlobalState();

export const pluginMap = registryState.pluginMap;
export const adapterInstances = registryState.adapterInstances;
export const adapterMtimes = registryState.adapterMtimes;
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

// Captured once at module load. Tests that mutate NODE_ENV later will not
// change this value; use a thunk if new behavior needs live NODE_ENV reads.
export const IS_DEV = process.env.NODE_ENV !== 'production';
