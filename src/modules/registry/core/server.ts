import { hasCompendiumPackConfig, hasInitialize, SystemAdapter, SystemModuleInfo, SystemPlugin } from './types';
import type { CompendiumPackConfig } from '@shared/sdk';
export * from './utils';
import { logger } from '@shared/utils/logger';
import { BaseSystemAdapter } from '@shared/sdk/base';
import { ModuleSourceCategory, ModuleSourceKind, ModuleLifecycleStatus, ManagerOutcome, ManagerAction, ArtifactVerificationStatus, ModuleTrustTier } from '@shared/types/modules';

// Internal platform fallback adapter — not a discoverable plugin, cannot be disabled.
// Used when no matching system module is found for an actor. Exported so the
// adapterResolution satellite can reference it without re-declaring (Phase 3).
class FallbackAdapter extends BaseSystemAdapter {
    systemId = 'generic';
}
export const FALLBACK_ADAPTER: SystemAdapter = new FallbackAdapter();
import path from 'node:path';
import fs from 'node:fs';
import {
    applyLifecycleClassification,
    createEmptyLifecycleStore,
    getLifecycleRecords,
    loadLifecycleStore,
    ModuleLifecycleClassificationInput,
    ModuleLifecycleRecord,
    ModuleLifecycleStore,
    recordLifecycleRuntimeFailure,
    saveLifecycleStore,
    upsertDiscoveredModule
} from '../lifecycle/lifecycle';
import { evaluateModuleCompatibility, validateModuleInfoShape } from '../lifecycle/validation';
import {
    installModule,
    uninstallModule,
    upgradeModule,
    operationFailure,
    operationSuccess,
    type InstallModuleInput,
    type UpgradeModuleInput,
    type ManagerOperationResult,
    ModuleArtifactMetadata,
} from './manager';
import { getArtifact, loadArtifactStore, saveArtifactStore, upsertArtifactVerification } from '../distribution/artifactStore';
import {
    evaluateTrustPolicy,
    type ModuleTrustPolicyConfig,
    type TrustPolicyDecision,
} from '../security/trustPolicy';
import { verifyArtifactMetadata, type ArtifactVerificationOutcome } from '../security/artifactVerification';
import { evaluatePermissionDelta, type PermissionDeltaResult } from '../security/permissionPolicy';
import {
    type ModuleSourceResolution,
} from '../distribution/sourceAdapters';
import { getModulesDataDir, getLocalModulesDir } from '@/server/core/paths';

// Shared registry state + cross-cutting private helpers (ADR-0022 Phase 3).
import {
    pluginMap,
    adapterInstances,
    adapterMtimes,
    lifecycleStore,
    isInitialized,
    setInitialized,
    getUniquePlugins,
    IS_DEV,
} from './state';
import {
    resolveLogicPath,
    getLogicMtime,
    getLifecycleStateFilePathOverride,
    getArtifactStateFilePathOverride,
    buildSourceResolutionContext,
    resolveManagedSource,
    isManifestFailOpenEnabled,
    getTrustPolicyConfig,
    getLifecycleRecord,
    isModuleEnabledForRuntime,
    getCoreVersion,
} from './internals';

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

/**
 * Boot-Time Scanner: Discovers all modules in <DATA_DIR>/modules and <DATA_DIR>/local/modules, validates their manifests, and builds the initial registry map.
 * Uses Node.js 'fs' to build the initial system index.
 */
export function initializeRegistry() {
    if (typeof window !== 'undefined' || isInitialized()) return;

    try {
        const stateFilePath = getLifecycleStateFilePathOverride();
        const loadedStore = loadLifecycleStore(stateFilePath);
        lifecycleStore.version = loadedStore.version;
        lifecycleStore.modules = loadedStore.modules;
        const coreVersion = getCoreVersion();

        const builtInModulesDir = path.join(process.cwd(), 'src', 'modules');
        const dataModulesDir = getModulesDataDir();
        const localModulesDir = getLocalModulesDir();

        const scanDirs: Array<{ source: ModuleSourceCategory; path: string }> = [
            { path: builtInModulesDir, source: ModuleSourceCategory.BuiltIn },
            { path: dataModulesDir,    source: ModuleSourceCategory.Managed },
        ];

        // Local dev modules — scanned and loaded but never managed by the lifecycle system.
        // Set SHEET_DELVER_LOCAL_MODULES=<path> or create a dev-modules/ directory at project root.
        if (localModulesDir) {
            scanDirs.push({ path: localModulesDir, source: ModuleSourceCategory.Local });
        }

        pluginMap.clear();

        // Pass 1 collects every candidate plugin keyed by id+source. Pass 2
        // (further down) picks the active plugin per id according to the
        // lifecycle record's `activeSource` (so that flipping a module from
        // its data install to its local dev copy in the admin UI actually
        // takes effect on the next refreshRegistry()).
        type SourceTag = ModuleSourceCategory;
        const candidates = new Map<string, Map<SourceTag, SystemPlugin>>();

        for (const scanDir of scanDirs) {
            const modulesDir = scanDir.path;
            if (!fs.existsSync(modulesDir)) {
                if (scanDir.source === ModuleSourceCategory.BuiltIn) {
                    logger.error(`Registry [PID:${process.pid}] | Built-in modules directory NOT FOUND at: ${modulesDir}`);
                }
                continue;
            }

            logger.info(`Registry [PID:${process.pid}] | Scanning ${scanDir.source} modules directory: ${modulesDir}`);
            const entries = fs.readdirSync(modulesDir, { withFileTypes: true });

            for (const entry of entries) {
                // Skip the registry itself and non-directories
                if (!entry.isDirectory() || entry.name === 'registry') continue;

                const modulePath = path.join(modulesDir, entry.name);
                const infoPath = path.join(modulePath, 'info.json');

                if (!fs.existsSync(infoPath)) {
                    logger.warn(`Registry | Skipping folder "${entry.name}": Missing info.json manifest.`);
                    const moduleId = entry.name.toLowerCase();
                    upsertDiscoveredModule(lifecycleStore, {
                        moduleId,
                        title: entry.name,
                        directory: modulePath
                    });
                    applyLifecycleClassification(lifecycleStore, moduleId, scanDir.source, {
                        status: ModuleLifecycleStatus.Errored,
                        enabled: false,
                        reason: 'Missing info.json manifest',
                        manifestValid: false,
                        validationErrors: ['Missing info.json manifest'],
                        compatible: false,
                        coreVersion
                    });
                    continue;
                }

                try {
                    const rawInfo = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as unknown;
                    const shapeValidation = validateModuleInfoShape(rawInfo);

                    const fallbackId = entry.name.toLowerCase();
                    const fallbackTitle = entry.name;
                    const inferredId = (
                        typeof rawInfo === 'object'
                        && rawInfo !== null
                        && 'id' in rawInfo
                        && typeof (rawInfo as { id?: unknown }).id === 'string'
                    )
                        ? String((rawInfo as { id: string }).id).toLowerCase()
                        : fallbackId;
                    const inferredTitle = (
                        typeof rawInfo === 'object'
                        && rawInfo !== null
                        && 'title' in rawInfo
                        && typeof (rawInfo as { title?: unknown }).title === 'string'
                    )
                        ? String((rawInfo as { title: string }).title)
                        : fallbackTitle;

                    upsertDiscoveredModule(lifecycleStore, {
                        moduleId: inferredId,
                        title: inferredTitle,
                        directory: modulePath
                    });

                    if (!shapeValidation.valid) {
                        applyLifecycleClassification(lifecycleStore, inferredId, scanDir.source, {
                            status: ModuleLifecycleStatus.Errored,
                            enabled: false,
                            reason: shapeValidation.errors.join('; '),
                            manifestValid: false,
                            validationErrors: shapeValidation.errors,
                            compatible: false,
                            coreVersion
                        });
                        logger.error(`Registry | Invalid manifest for "${entry.name}": ${shapeValidation.errors.join('; ')}`);
                        continue;
                    }

                    const info = rawInfo as SystemModuleInfo;
                    const compatibility = evaluateModuleCompatibility(info, coreVersion);

                    if (!compatibility.compatible) {
                        applyLifecycleClassification(lifecycleStore, inferredId, scanDir.source, {
                            status: ModuleLifecycleStatus.Incompatible,
                            enabled: false,
                            reason: compatibility.reason || 'Incompatible with current core version',
                            manifestValid: true,
                            compatible: false,
                            coreVersion: compatibility.coreVersion,
                            requiredCoreVersion: compatibility.requiredCoreVersion,
                            requiredApiContracts: compatibility.requiredApiContracts,
                            providedApiContracts: compatibility.providedApiContracts,
                            coreDiagnostics: compatibility.coreDiagnostics,
                            contractDiagnostics: compatibility.contractDiagnostics,
                        });
                        logger.warn(`Registry | Module "${entry.name}" is incompatible: ${compatibility.reason || 'unknown reason'}`);
                        continue;
                    }

                    const plugin: SystemPlugin = {
                        info,
                        directory: modulePath,
                        source: scanDir.source,
                        // Thunk-based lazy loading using absolute paths to support data/modules
                        getLogic: () => import(path.join(modulePath, info.manifest.logic)),
                        getUI: () => import(path.join(modulePath, info.manifest.ui)),
                        getServer: info.manifest.server ? () => import(path.join(modulePath, info.manifest.server ?? '')) : undefined
                    };

                    const primaryId = info.id.toLowerCase();

                    // Stash this candidate. We keep one plugin per (id, source)
                    // pair so that a local dev copy and a managed data install
                    // of the same module both survive discovery; Pass 2 picks
                    // which one populates pluginMap.
                    if (!candidates.has(primaryId)) candidates.set(primaryId, new Map());
                    candidates.get(primaryId)!.set(scanDir.source, plugin);

                    // Track the local directory on the lifecycle record so the
                    // admin UI can offer a "switch source" option even when
                    // the active plugin is currently the data version.
                    if (scanDir.source === ModuleSourceCategory.Local) {
                        const rec = lifecycleStore.modules[primaryId];
                        if (rec) rec.localDirectory = modulePath;
                    }

                    logger.info(`Registry [PID:${process.pid}] | Discovered ${scanDir.source} module: ${info.title} (${primaryId})`);
                    if (info.experimental) {
                        logger.warn(`Registry [PID:${process.pid}] | Experimental module hidden from public registry: ${info.title} (${primaryId})`);
                    }
                } catch (err) {
                    logger.error(`Registry | Failed to parse manifest for "${entry.name}" in ${scanDir.source}:`, err);
                }
            }
        }

        // Pass 2 — pick the active plugin per id.
        //
        // Selection priority:
        //   1. The lifecycle record's `activeSource`, if it points at a
        //      candidate that actually exists. This is what makes
        //      `setActiveSource(ModuleSourceCategory.Local)` followed by `refreshRegistry()`
        //      actually swap the loaded plugin.
        //   2. Otherwise, fall back to the discovery priority order
        //      (built-in > data > local), matching the previous behavior
        //      for fresh installs.
        for (const [id, sources] of candidates) {
            const rec = lifecycleStore.modules[id];
            const preferred = rec?.activeSource as SourceTag | undefined;

            const chosen =
                (preferred && sources.get(preferred)) ??
                sources.get(ModuleSourceCategory.BuiltIn) ??
                sources.get(ModuleSourceCategory.Managed) ??
                sources.get(ModuleSourceCategory.Local);

            if (!chosen) continue;
            pluginMap.set(id, chosen);

            // Reflect the chosen source back so that boot-time discovery and
            // the lifecycle record stay in sync (handy for first-boot when
            // activeSource was previously unset).
            if (rec) {
                if (!rec.activeSource) rec.activeSource = chosen.source as ModuleSourceCategory;
                rec.directory = chosen.directory;
            }

            const existingLifecycle = lifecycleStore.modules[id];
            const enabled = existingLifecycle ? existingLifecycle.enabled : true;
            const compat = evaluateModuleCompatibility(chosen.info, coreVersion);
            applyLifecycleClassification(lifecycleStore, id, chosen.source as ModuleSourceCategory, {
                status: enabled ? ModuleLifecycleStatus.Validated : ModuleLifecycleStatus.Disabled,
                enabled,
                reason: enabled ? undefined : 'Module disabled in persisted lifecycle state',
                activeSource: existingLifecycle?.activeSource ?? (chosen.source === ModuleSourceCategory.Local ? ModuleSourceCategory.Local : chosen.source === ModuleSourceCategory.Managed ? ModuleSourceCategory.Managed : undefined),
                manifestValid: true,
                compatible: true,
                coreVersion,
                requiredCoreVersion: compat.requiredCoreVersion,
                requiredApiContracts: compat.requiredApiContracts,
                providedApiContracts: compat.providedApiContracts,
                coreDiagnostics: compat.coreDiagnostics,
                contractDiagnostics: compat.contractDiagnostics,
            });
        }

        saveLifecycleStore(lifecycleStore, stateFilePath);
        setInitialized(true);
    } catch (err) {
        logger.error('Registry | Fatal error during boot-time discovery:', err);
    }
}

export function getModuleLifecycleState() {
    if (!isInitialized()) initializeRegistry();
    return getLifecycleRecords(lifecycleStore);
}

/**
 * Force a re-scan of module directories and update the internal registry map.
 */
export function refreshRegistry(): void {
    // Clear adapter instances so they are lazily re-loaded against the refreshed plugin map.
    adapterInstances.clear();
    adapterMtimes.clear();
    setInitialized(false);
    initializeRegistry();
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
