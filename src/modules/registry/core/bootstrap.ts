import path from 'node:path';
import fs from 'node:fs';
import { logger } from '@shared/utils/logger';
import { ModuleLifecycleStatus, ModuleSourceCategory } from '@shared/types/modules';
import type { SystemPlugin } from './types';
import {
    applyLifecycleClassification,
    loadLifecycleStore,
    saveLifecycleStore,
    upsertDiscoveredModule,
} from '../lifecycle/lifecycle';
import { validatePackagedModuleArtifact, type ModuleArtifactHealthResult } from '../lifecycle/artifactHealth';
import { evaluateModuleCompatibility, validateModuleInfoShape } from '../lifecycle/validation';
import { getModulesDataDir, getLocalModulesDir } from '@/server/core/paths';
import {
    adapterInstances,
    adapterMtimes,
    isInitialized,
    lifecycleStore,
    pluginMap,
    setInitialized,
} from './state';
import {
    getCoreVersion,
    getLifecycleStateFilePathOverride,
} from './internals';

/**
 * Boot-Time Scanner: Discovers all modules in <DATA_DIR>/modules and
 * <DATA_DIR>/local/modules, validates their manifests, and builds the initial
 * registry map.
 */
export function initializeRegistry() {
    if (typeof window !== 'undefined' || isInitialized()) return;

    try {
        const stateFilePath = getLifecycleStateFilePathOverride();
        const loadedStore = loadLifecycleStore(stateFilePath);
        lifecycleStore.version = loadedStore.version;
        lifecycleStore.modules = loadedStore.modules;
        const coreVersion = getCoreVersion();

        const dataModulesDir = getModulesDataDir();
        const localModulesDir = getLocalModulesDir();

        const scanDirs: Array<{ source: ModuleSourceCategory; path: string }> = [
            { path: dataModulesDir, source: ModuleSourceCategory.Managed },
        ];

        if (localModulesDir) {
            scanDirs.push({ path: localModulesDir, source: ModuleSourceCategory.Local });
        }

        pluginMap.clear();

        type SourceTag = ModuleSourceCategory;
        const candidates = new Map<string, Map<SourceTag, SystemPlugin>>();
        // Managed artifact health is gathered while scanning and applied later when
        // each source is classified. Keeping it per source prevents local-dev state
        // from inheriting warnings/errors from an old installed package.
        const artifactHealthBySource = new Map<string, Map<SourceTag, ModuleArtifactHealthResult>>();

        const setArtifactHealth = (moduleId: string, source: SourceTag, result: ModuleArtifactHealthResult): void => {
            if (!artifactHealthBySource.has(moduleId)) artifactHealthBySource.set(moduleId, new Map());
            artifactHealthBySource.get(moduleId)!.set(source, result);
        };

        for (const scanDir of scanDirs) {
            const modulesDir = scanDir.path;
            if (!fs.existsSync(modulesDir)) {
                continue;
            }

            logger.info(`Registry [PID:${process.pid}] | Scanning ${scanDir.source} modules directory: ${modulesDir}`);
            const entries = fs.readdirSync(modulesDir, { withFileTypes: true });

            for (const entry of entries) {
                if (!entry.isDirectory() || entry.name === 'registry') continue;

                const modulePath = path.join(modulesDir, entry.name);
                const infoPath = path.join(modulePath, 'info.json');

                if (!fs.existsSync(infoPath)) {
                    logger.warn(`Registry | Skipping folder "${entry.name}": Missing info.json manifest.`);
                    const moduleId = entry.name.toLowerCase();
                    upsertDiscoveredModule(lifecycleStore, {
                        moduleId,
                        title: entry.name,
                        directory: modulePath,
                    });
                    applyLifecycleClassification(lifecycleStore, moduleId, scanDir.source, {
                        status: ModuleLifecycleStatus.Errored,
                        enabled: false,
                        reason: 'Missing info.json manifest',
                        manifestValid: false,
                        validationErrors: ['Missing info.json manifest'],
                        compatible: false,
                        coreVersion,
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
                        directory: modulePath,
                    });

                    if (!shapeValidation.valid) {
                        applyLifecycleClassification(lifecycleStore, inferredId, scanDir.source, {
                            status: ModuleLifecycleStatus.Errored,
                            enabled: false,
                            reason: shapeValidation.errors.join('; '),
                            manifestValid: false,
                            validationErrors: shapeValidation.errors,
                            compatible: false,
                            coreVersion,
                        });
                        logger.error(`Registry | Invalid manifest for "${entry.name}": ${shapeValidation.errors.join('; ')}`);
                        continue;
                    }

                    const info = rawInfo as SystemPlugin['info'];
                    const compatibility = evaluateModuleCompatibility(info, coreVersion);
                    // Do not run full module:check here. Installed modules may be old
                    // but still usable; this lightweight audit only blocks load-breaking
                    // packaged artifacts and reports survivable drift as warnings.
                    const artifactHealth = scanDir.source === ModuleSourceCategory.Managed
                        ? validatePackagedModuleArtifact(modulePath, info)
                        : undefined;
                    if (artifactHealth) {
                        setArtifactHealth(info.id.toLowerCase(), scanDir.source, artifactHealth);
                        for (const diagnostic of artifactHealth.diagnostics) {
                            const message = `Registry | Packaged module health (${info.id}/${scanDir.source}): ${diagnostic.message}`;
                            if (diagnostic.severity === 'error') logger.error(message);
                            else logger.warn(message);
                        }
                    }

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
                        getLogic: () => import(path.join(modulePath, info.manifest.logic)),
                        getUI: () => import(path.join(modulePath, info.manifest.ui)),
                        getServer: info.manifest.server ? () => import(path.join(modulePath, info.manifest.server ?? '')) : undefined,
                    };

                    const primaryId = info.id.toLowerCase();
                    if (!candidates.has(primaryId)) candidates.set(primaryId, new Map());
                    candidates.get(primaryId)!.set(scanDir.source, plugin);

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

        for (const [id, sources] of candidates) {
            const rec = lifecycleStore.modules[id];
            const preferred = rec?.activeSource as SourceTag | undefined;

            const chosen =
                (preferred && sources.get(preferred)) ??
                sources.get(ModuleSourceCategory.Managed) ??
                sources.get(ModuleSourceCategory.Local);

            if (!chosen) continue;
            pluginMap.set(id, chosen);

            if (rec) {
                if (!rec.activeSource) rec.activeSource = chosen.source as ModuleSourceCategory;
                rec.directory = chosen.directory;
            }

            const existingLifecycle = lifecycleStore.modules[id];
            const activeSource = existingLifecycle?.activeSource
                ?? (chosen.source === ModuleSourceCategory.Local ? ModuleSourceCategory.Local : chosen.source === ModuleSourceCategory.Managed ? ModuleSourceCategory.Managed : undefined);

            // Classify every discovered source, not just the active one, so the admin
            // split cards can explain why a dormant local/managed source can or cannot
            // be enabled. Only the active source updates the top-level lifecycle record.
            for (const [source, plugin] of sources) {
                const sourceState = existingLifecycle?.sourceStates?.[source];
                const enabled = source === activeSource
                    ? (existingLifecycle ? existingLifecycle.enabled : true)
                    : sourceState?.enabled ?? (
                        source === ModuleSourceCategory.Local
                            ? existingLifecycle?.localEnabled
                            : source === ModuleSourceCategory.Managed
                                ? existingLifecycle?.managedEnabled
                                : undefined
                    ) ?? true;
                const compat = evaluateModuleCompatibility(plugin.info, coreVersion);
                const artifactHealth = artifactHealthBySource.get(id)?.get(source);
                const blockingArtifactError = artifactHealth?.hasErrors === true;
                const firstArtifactError = artifactHealth?.diagnostics.find(diagnostic => diagnostic.severity === 'error')?.message;
                // Warnings remain loadable; only health errors convert the source to
                // `errored` and force enabled=false.
                applyLifecycleClassification(lifecycleStore, id, source as ModuleSourceCategory, {
                    status: blockingArtifactError
                        ? ModuleLifecycleStatus.Errored
                        : enabled ? ModuleLifecycleStatus.Validated : ModuleLifecycleStatus.Disabled,
                    enabled: blockingArtifactError ? false : enabled,
                    reason: blockingArtifactError
                        ? firstArtifactError || 'Packaged module artifact failed health checks'
                        : enabled ? undefined : 'Module disabled in persisted lifecycle state',
                    activeSource,
                    manifestValid: true,
                    compatible: true,
                    coreVersion,
                    requiredCoreVersion: compat.requiredCoreVersion,
                    requiredApiContracts: compat.requiredApiContracts,
                    providedApiContracts: compat.providedApiContracts,
                    coreDiagnostics: compat.coreDiagnostics,
                    contractDiagnostics: compat.contractDiagnostics,
                    artifactDiagnostics: artifactHealth?.diagnostics,
                });
            }
        }

        saveLifecycleStore(lifecycleStore, stateFilePath);
        setInitialized(true);
    } catch (err) {
        logger.error('Registry | Fatal error during boot-time discovery:', err);
    }
}

/**
 * Force a re-scan of module directories and update the internal registry map.
 */
export function refreshRegistry(): void {
    adapterInstances.clear();
    adapterMtimes.clear();
    setInitialized(false);
    initializeRegistry();
}
