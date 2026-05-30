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

        const builtInModulesDir = path.join(process.cwd(), 'src', 'modules');
        const dataModulesDir = getModulesDataDir();
        const localModulesDir = getLocalModulesDir();

        const scanDirs: Array<{ source: ModuleSourceCategory; path: string }> = [
            { path: builtInModulesDir, source: ModuleSourceCategory.BuiltIn },
            { path: dataModulesDir, source: ModuleSourceCategory.Managed },
        ];

        if (localModulesDir) {
            scanDirs.push({ path: localModulesDir, source: ModuleSourceCategory.Local });
        }

        pluginMap.clear();

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
                sources.get(ModuleSourceCategory.BuiltIn) ??
                sources.get(ModuleSourceCategory.Managed) ??
                sources.get(ModuleSourceCategory.Local);

            if (!chosen) continue;
            pluginMap.set(id, chosen);

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

/**
 * Force a re-scan of module directories and update the internal registry map.
 */
export function refreshRegistry(): void {
    adapterInstances.clear();
    adapterMtimes.clear();
    setInitialized(false);
    initializeRegistry();
}
