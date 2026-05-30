import type { SystemModuleInfo } from './types';
export * from './utils';
import { ModuleLifecycleStatus } from '@shared/types/modules';
import {
    getLifecycleRecords,
    ModuleLifecycleRecord,
} from '../lifecycle/lifecycle';
import { type ModuleArtifactMetadata } from './manager';
import { getArtifact, loadArtifactStore } from '../distribution/artifactStore';
import {
    pluginMap,
    adapterInstances,
    lifecycleStore,
    isInitialized,
    setInitialized,
    getUniquePlugins,
} from './state';
import {
    getArtifactStateFilePathOverride,
    getLifecycleRecord,
} from './internals';
import { initializeRegistry } from './bootstrap';
export { initializeRegistry, refreshRegistry } from './bootstrap';
export { FALLBACK_ADAPTER } from './fallbackAdapter';

export interface RegisteredModuleRuntimeInfo {
    info: SystemModuleInfo;
    directory: string;
    lifecycle: ModuleLifecycleRecord;
    enabled: boolean;
    status: ModuleLifecycleStatus;
    reason?: string;
    managed: boolean;
    artifact?: ModuleArtifactMetadata;
}

export function getModuleLifecycleState() {
    if (!isInitialized()) initializeRegistry();
    return getLifecycleRecords(lifecycleStore);
}

export function listModules(options?: { includeExperimental?: boolean; includeDisabled?: boolean }): RegisteredModuleRuntimeInfo[] {
    if (!isInitialized()) initializeRegistry();
    const artifactStore = loadArtifactStore(getArtifactStateFilePathOverride());

    return getUniquePlugins()
        .filter((plugin) => options?.includeExperimental || !plugin.info.experimental)
        .map((plugin) => {
            const moduleId = plugin.info.id.toLowerCase();
            const fallbackLifecycle: ModuleLifecycleRecord = {
                moduleId,
                title: plugin.info.title,
                directory: plugin.directory,
                status: ModuleLifecycleStatus.Discovered,
                enabled: true,
                firstSeenAt: 0,
                lastSeenAt: 0,
                updatedAt: 0
            };
            const lifecycle = getLifecycleRecord(moduleId) || fallbackLifecycle;
            const artifact = getArtifact(artifactStore, moduleId);

            // A module is managed if it has an artifact record (meaning it was installed/managed via the system).
            const managed = !!artifact;

            return {
                info: plugin.info,
                directory: plugin.directory,
                lifecycle,
                enabled: lifecycle.enabled,
                status: lifecycle.status,
                reason: lifecycle.reason,
                artifact,
                managed
            };
        })
        .filter((entry) => options?.includeDisabled || entry.enabled);
}

// Module-source operations moved to ./moduleSources per ADR-0022 Phase 3.
export {
    switchModuleSource,
    disableModule,
    enableModule,
} from './moduleSources';

export function __resetRegistryForTests() {
    pluginMap.clear();
    adapterInstances.clear();
    lifecycleStore.version = 1;
    lifecycleStore.modules = {};
    setInitialized(false);
}

// Lifecycle preflight checks moved to ./lifecyclePreflight per ADR-0022 Phase 3.
export { checkCanEnableModule, checkCanDisableModule } from './lifecyclePreflight';

/**
 * Returns all discovered system manifests.
 * Used by the Core Service to expose available systems to the frontend.
 */
export function getRegisteredModules(options?: { includeExperimental?: boolean }) {
    return listModules({ includeExperimental: options?.includeExperimental, includeDisabled: true })
        .map((entry) => entry.info);
}

// getModuleCompendiumPackConfig moved to ./compendiumConfig (ADR-0022 Phase 3)
export { getModuleCompendiumPackConfig } from './compendiumConfig';

export { getModuleActiveSources } from './moduleSources';

// Adapter resolution (getAdapter / getServerModule / unloadSystemModules /
// getMatchingAdapter) moved to ./adapterResolution per ADR-0022 Phase 3.
export {
    getAdapter,
    getServerModule,
    unloadSystemModules,
    getMatchingAdapter,
} from './adapterResolution';

// Managed-module operations moved to ./managedModules per ADR-0022 Phase 3.
export {
    dryRunInstallManagedModule,
    dryRunUpgradeManagedModule,
    installManagedModule,
    upgradeManagedModule,
    uninstallManagedModule,
    validateManagedModule,
    type InstallManagedModuleInput,
    type UpgradeManagedModuleInput,
    type DryRunManagedModuleResult,
} from './managedModules';
