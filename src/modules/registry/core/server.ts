import { hasInitialize, SystemAdapter, SystemModuleInfo, SystemPlugin } from './types';
export * from './utils';
import { logger } from '@shared/utils/logger';
import { BaseSystemAdapter } from '@shared/sdk/base';

// Internal platform fallback adapter — not a discoverable plugin, cannot be disabled.
// Used when no matching system module is found for an actor.
class FallbackAdapter extends BaseSystemAdapter {
    systemId = 'generic';
}
const FALLBACK_ADAPTER: SystemAdapter = new FallbackAdapter();
import path from 'node:path';
import fs from 'node:fs';
import {
    applyLifecycleClassification,
    createEmptyLifecycleStore,
    getLifecycleRecords,
    loadLifecycleStore,
    ModuleLifecycleClassificationInput,
    ModuleLifecycleRecord,
    ModuleLifecycleStatus,
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
    getDefaultModuleTrustPolicy,
    type ModuleTrustPolicyConfig,
    type TrustPolicyDecision,
} from '../security/trustPolicy';
import { getConfig } from '@server/core/config';
import { verifyArtifactMetadata, type ArtifactVerificationOutcome } from '../security/artifactVerification';
import { evaluatePermissionDelta, type PermissionDeltaResult } from '../security/permissionPolicy';
import {
    getDefaultModuleSourceAdapters,
    resolveModuleSource,
    type ModuleSourceResolution,
    type SourceResolutionContext,
} from '../distribution/sourceAdapters';
import { validateModuleIndexDocument, type ModuleIndexDocument } from '../distribution/moduleIndex';
import { getModulesDataDir, getLocalModulesDir } from '@/server/core/paths';

const LIFECYCLE_STATE_FILE_ENV = 'SHEET_DELVER_MODULE_STATE_FILE';
const ARTIFACT_STATE_FILE_ENV = 'SHEET_DELVER_MODULE_ARTIFACT_FILE';
const MANIFEST_FAIL_OPEN_ENV = 'SHEET_DELVER_MANIFEST_FAIL_OPEN';
const MODULE_INDEX_FILE_ENV = 'SHEET_DELVER_MODULE_INDEX_FILE';

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

interface RegistryState {
    pluginMap: Map<string, SystemPlugin>;
    adapterInstances: Map<string, any>;
    adapterMtimes: Map<string, number>;
    isInitialized: boolean;
    lifecycleStore: ModuleLifecycleStore;
}

// In-Memory Cache for Discovered Modules & Active Adapters
// Use globalThis to shared state across dual-loaded modules
const getGlobalState = (): RegistryState => {
    const g = globalThis as any;
    if (!g.__coreRegistry) {
        g.__coreRegistry = {
            pluginMap: new Map<string, SystemPlugin>(),
            adapterInstances: new Map<string, any>(),
            adapterMtimes: new Map<string, number>(),
            isInitialized: false,
            lifecycleStore: createEmptyLifecycleStore()
        };
    }
    return g.__coreRegistry;
};

const _state = getGlobalState();
const pluginMap = _state.pluginMap;
const adapterInstances = _state.adapterInstances;
const adapterMtimes = _state.adapterMtimes;
const lifecycleStore = _state.lifecycleStore;

const IS_DEV = process.env.NODE_ENV !== 'production';

/** Resolve the actual file path for a module logic entry (adds extension if needed). */
function resolveLogicPath(base: string): string {
    for (const ext of ['.ts', '.tsx', '.js', '.mjs']) {
        if (fs.existsSync(base + ext)) return base + ext;
    }
    return base;
}

/** Return the mtime (ms) of a logic file, 0 if unresolvable. */
function getLogicMtime(plugin: SystemPlugin): number {
    try {
        const resolved = resolveLogicPath(path.join(plugin.directory, plugin.info.manifest.logic));
        return fs.statSync(resolved).mtimeMs;
    } catch {
        return 0;
    }
}
const isInitialized = () => _state.isInitialized;
const setInitialized = (val: boolean) => { _state.isInitialized = val; };

const getUniquePlugins = () => Array.from(new Set(pluginMap.values()));

function getLifecycleStateFilePathOverride(): string | undefined {
    const value = process.env[LIFECYCLE_STATE_FILE_ENV];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getArtifactStateFilePathOverride(): string | undefined {
    const value = process.env[ARTIFACT_STATE_FILE_ENV];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function buildSourceResolutionContext(sourceRef: string): Promise<{ ok: true; context?: SourceResolutionContext } | { ok: false; error: string }> {
    if (!sourceRef.startsWith('index://')) {
        return { ok: true };
    }

    const indexFilePath = process.env[MODULE_INDEX_FILE_ENV];
    if (indexFilePath && indexFilePath.trim()) {
        try {
            const raw = fs.readFileSync(indexFilePath, 'utf8');
            const parsed = JSON.parse(raw) as ModuleIndexDocument;
            const validation = validateModuleIndexDocument(parsed);
            if (!validation.valid) {
                return {
                    ok: false,
                    error: `Index document is invalid: ${validation.errors.join('; ')}`,
                };
            }

            return {
                ok: true,
                context: {
                    indexes: {
                        [sourceRef]: parsed,
                    },
                },
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                ok: false,
                error: `Failed to load module index from ${indexFilePath}: ${message}`,
            };
        }
    }

    try {
        const { loadSourceProfiles } = await import('../distribution/sourceProfiles');
        const { fetchRemoteIndex } = await import('../distribution/remoteIndexFetcher');
        const { isHostAllowed } = await import('../security/sourceGovernance');
        const { getConfig } = await import('../../../server/core/config');

        const config = getConfig();
        const allowlist = config?.security?.sourceGovernance?.hostAllowlist ?? [];
        const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';

        const profiles = loadSourceProfiles().filter(p => p.enabled && p.kind === 'indexed');



        const indexes: Record<string, ModuleIndexDocument> = {};
        for (const profile of profiles) {
            if (!isHostAllowed(profile.baseUrl, allowlist, mode)) {
                logger.error(`[Registry] Skipping source profile "${profile.name}" due to governance violation (host not allowed)`);
                continue;
            }

            const result = await fetchRemoteIndex(profile.baseUrl, { auth: profile.auth });
            if (result.ok && result.index) {
                indexes[profile.baseUrl] = result.index;
                if (sourceRef === 'index://' || sourceRef === profile.baseUrl || profile.baseUrl.includes(sourceRef.replace('index://', ''))) {
                    if (sourceRef === 'index://') {
                        if (!indexes[sourceRef]) {
                            indexes[sourceRef] = { ...result.index, modules: { ...result.index.modules } };
                        } else {
                            Object.assign(indexes[sourceRef].modules, result.index.modules);
                        }
                    } else {
                        indexes[sourceRef] = result.index;
                    }
                }
            }
        }

        return { ok: true, context: { indexes } };
    } catch (err) {
        return { ok: false, error: 'Failed to fetch remote indexes' };
    }
}

async function resolveManagedSource(moduleId: string, sourceRef: string, targetVersion?: string): Promise<{ ok: true; value: ModuleSourceResolution } | { ok: false; error: string }> {
    const contextResult = await buildSourceResolutionContext(sourceRef);
    if (!contextResult.ok) {
        return contextResult;
    }

    const resolved = resolveModuleSource(
        getDefaultModuleSourceAdapters(),
        {
            moduleId,
            sourceRef,
            targetVersion,
        },
        contextResult.context
    );

    if (!resolved.ok || !resolved.value) {
        return {
            ok: false,
            error: resolved.error || 'Failed to resolve module source',
        };
    }

    return {
        ok: true,
        value: resolved.value,
    };
}

function isManifestFailOpenEnabled(): boolean {
    if (process.env.NODE_ENV === 'production') return false;
    return process.env[MANIFEST_FAIL_OPEN_ENV] === 'true';
}

function getTrustPolicyConfig(): ModuleTrustPolicyConfig {
    try {
        const config = getConfig();
        return config.security.modulePolicy;
    } catch {
        return getDefaultModuleTrustPolicy(process.env);
    }
}

function getLifecycleRecord(moduleId: string): ModuleLifecycleRecord | undefined {
    return lifecycleStore.modules[moduleId.toLowerCase()];
}

function isModuleEnabledForRuntime(moduleId: string): boolean {
    const record = getLifecycleRecord(moduleId);
    if (!record) return true;
    if (!record.enabled) return false;
    return record.status !== 'incompatible' && record.status !== 'errored';
}

function getCoreVersion(): string {
    try {
        const packagePath = path.join(process.cwd(), 'package.json');
        const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: unknown };
        return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
    } catch {
        return '0.0.0';
    }
}

/**
 * Boot-Time Scanner: Discovers all modules in src/modules/
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

        const scanDirs: Array<{ source: 'built-in' | 'data' | 'local'; path: string }> = [
            { path: builtInModulesDir, source: 'built-in' },
            { path: dataModulesDir,    source: 'data' },
        ];

        // Local dev modules — scanned and loaded but never managed by the lifecycle system.
        // Set SHEET_DELVER_LOCAL_MODULES=<path> or create a dev-modules/ directory at project root.
        if (localModulesDir) {
            scanDirs.push({ path: localModulesDir, source: 'local' });
        }

        pluginMap.clear();

        for (const scanDir of scanDirs) {
            const modulesDir = scanDir.path;
            if (!fs.existsSync(modulesDir)) {
                if (scanDir.source === 'built-in') {
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
                    applyLifecycleClassification(lifecycleStore, moduleId, {
                        status: 'errored',
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
                        applyLifecycleClassification(lifecycleStore, inferredId, {
                            status: 'errored',
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
                        applyLifecycleClassification(lifecycleStore, inferredId, {
                            status: 'incompatible',
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

                    // When a local dev module has the same ID as an already-registered data/built-in module:
                    // record the local path in the lifecycle record so the user can switch between them,
                    // but leave the active plugin (pluginMap) pointing at the higher-priority source.
                    const existingPlugin = pluginMap.get(primaryId);
                    if (existingPlugin && scanDir.source === 'local') {
                        const existingRecord = lifecycleStore.modules[primaryId];
                        if (existingRecord) {
                            existingRecord.localDirectory = modulePath;
                            if (!existingRecord.activeSource) existingRecord.activeSource = existingPlugin.source === 'data' ? 'data' : 'local';
                            logger.info(`Registry | Local dev module "${primaryId}" found alongside ${existingPlugin.source} install — both tracked, ${existingRecord.activeSource} is active`);
                        }
                        continue;
                    }

                    pluginMap.set(primaryId, plugin);
                    const existingLifecycle = lifecycleStore.modules[primaryId];
                    const enabled = existingLifecycle ? existingLifecycle.enabled : true;
                    applyLifecycleClassification(lifecycleStore, primaryId, {
                        status: enabled ? 'validated' : 'disabled',
                        enabled,
                        reason: enabled ? undefined : 'Module disabled in persisted lifecycle state',
                        activeSource: existingLifecycle?.activeSource ?? (scanDir.source === 'local' ? 'local' : scanDir.source === 'data' ? 'data' : undefined),
                        manifestValid: true,
                        compatible: true,
                        coreVersion,
                        requiredCoreVersion: compatibility.requiredCoreVersion,
                        requiredApiContracts: compatibility.requiredApiContracts,
                        providedApiContracts: compatibility.providedApiContracts,
                        coreDiagnostics: compatibility.coreDiagnostics,
                        contractDiagnostics: compatibility.contractDiagnostics,
                    });
                    logger.info(`Registry [PID:${process.pid}] | Discovered module: ${info.title} (${primaryId})`);
                    if (info.experimental) {
                        logger.warn(`Registry [PID:${process.pid}] | Experimental module hidden from public registry: ${info.title} (${primaryId})`);
                    }
                } catch (err) {
                    logger.error(`Registry | Failed to parse manifest for "${entry.name}" in ${scanDir.source}:`, err);
                }
            }
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
                status: 'discovered',
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

/**
 * Switches a module between its local dev version and managed install.
 * Only valid when both localDirectory and a managed directory exist.
 * Evicts the adapter cache and re-runs the registry scan so the new source takes effect immediately.
 */
export function switchModuleSource(moduleId: string, source: 'local' | 'data'): { success: boolean; error?: string } {
    if (!isInitialized()) initializeRegistry();
    const id = moduleId.toLowerCase();
    const record = getLifecycleRecord(id);
    if (!record) return { success: false, error: 'Module not found' };

    // Persist the current enabled state for the source we're leaving
    if (record.activeSource === 'local') {
        record.localEnabled = record.enabled;
    } else {
        record.managedEnabled = record.enabled;
    }

    if (source === 'local') {
        if (!record.localDirectory) return { success: false, error: 'No local dev version available for this module' };
        record.directory    = record.localDirectory;
        record.activeSource = 'local';
        // Restore the saved enabled state for local, defaulting to true on first switch
        record.enabled = record.localEnabled ?? true;
    } else {
        const managedDir = path.join(getModulesDataDir(), id);
        if (!fs.existsSync(managedDir)) return { success: false, error: 'No managed install found for this module' };
        record.directory    = managedDir;
        record.activeSource = 'data';
        // Restore the saved enabled state for managed, defaulting to true on first switch
        record.enabled = record.managedEnabled ?? true;
    }

    record.status    = record.enabled ? 'validated' : 'disabled';
    record.reason    = record.enabled ? undefined : 'Module disabled in persisted lifecycle state';
    record.updatedAt = Date.now();
    unloadSystemModules(id);
    saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
    refreshRegistry();
    logger.info(`Registry | Module "${id}" switched to ${source} source (enabled: ${record.enabled})`);
    return { success: true };
}

/**
 * Disables a module. When `source` is supplied the operation targets that
 * source specifically:
 *   - If source === activeSource: disable the active install normally.
 *   - If source !== activeSource: only update the persisted per-source flag;
 *     the currently active source is unaffected (no switch required).
 */
export function disableModule(moduleId: string, reason = 'Module disabled by operator', source?: 'local' | 'data'): boolean {
    if (!isInitialized()) initializeRegistry();
    const id = moduleId.toLowerCase();

    const record = getLifecycleRecord(id);
    if (!record) return false;

    const targetSource = source ?? record.activeSource;

    if (targetSource !== record.activeSource) {
        // Targeting the dormant source — just update its persisted flag.
        if (targetSource === 'local') record.localEnabled   = false;
        else                          record.managedEnabled = false;
        record.updatedAt = Date.now();
        saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
        return true;
    }

    record.enabled = false;
    record.status  = 'disabled';
    record.reason  = reason;
    record.updatedAt = Date.now();

    if (record.activeSource === 'local') record.localEnabled   = false;
    else                                 record.managedEnabled = false;

    unloadSystemModules(id);
    saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
    return true;
}

/**
 * Enables a module. When `source` is supplied and it differs from the current
 * activeSource the module is switched to that source first, then enabled.
 * This makes "Enable Local Dev" and "Enable Managed" single atomic operations
 * from the operator's perspective.
 */
export function enableModule(moduleId: string, source?: 'local' | 'data'): boolean {
    if (!isInitialized()) initializeRegistry();
    const id = moduleId.toLowerCase();
    const record = getLifecycleRecord(id);
    if (!record) return false;

    // If the operator is targeting a source that isn't currently active, switch
    // to it first. switchModuleSource handles the per-source state bookkeeping.
    if (source && source !== record.activeSource) {
        const switchResult = switchModuleSource(id, source);
        if (!switchResult.success) return false;
    }

    if (record.validation && (!record.validation.manifestValid || !record.validation.compatible)) {
        record.enabled = false;
        record.status = record.validation.manifestValid ? 'incompatible' : 'errored';
        record.reason = record.validation.manifestValid
            ? 'Cannot enable incompatible module'
            : 'Cannot enable invalid module manifest';
        record.updatedAt = Date.now();
        saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
        return false;
    }

    record.enabled = true;
    record.status  = 'validated';
    record.reason  = undefined;
    record.updatedAt = Date.now();

    if (record.activeSource === 'local') record.localEnabled   = true;
    else                                 record.managedEnabled = true;

    saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
    return true;
}

interface ManifestGateResult {
    allowed: boolean;
    mode: 'strict' | 'fail-open';
    errorCode?: 'module-not-found' | 'validation-failed';
    reason?: string;
    classification?: ModuleLifecycleClassificationInput;
}

function checkManifestGate(moduleId: string, effectiveInfo?: SystemModuleInfo): ManifestGateResult {
    const id = moduleId.toLowerCase();
    const plugin = pluginMap.get(id);
    const record = getLifecycleRecord(id);

    if (record?.validation && (!record.validation.manifestValid || !record.validation.compatible)) {
        const reasons: string[] = [];
        if (!record.validation.manifestValid && record.validation.validationErrors?.length) {
            reasons.push(record.validation.validationErrors.join('; '));
        }
        if (!record.validation.compatible) {
            reasons.push(record.reason || 'Module is incompatible with current core version');
        }

        if (isManifestFailOpenEnabled()) {
            return {
                allowed: true,
                mode: 'fail-open',
                reason: reasons.join(' | ') || 'Manifest gate bypassed in development fail-open mode',
            };
        }

        return {
            allowed: false,
            mode: 'strict',
            errorCode: 'validation-failed',
            reason: reasons.join(' | ') || 'Manifest validation failed',
        };
    }

    const infoToValidate = effectiveInfo || plugin?.info;

    if (!infoToValidate) {
        return {
            allowed: false,
            mode: 'strict',
            errorCode: 'module-not-found',
            reason: `Module ${id} not found in registry and no remote metadata available`,
        };
    }

    if (!plugin) {
        // For remote modules, we don't have the full info.json yet (e.g. no manifest paths).
        // Skip structural shape validation and only check compatibility.
        const compatibility = evaluateModuleCompatibility(infoToValidate, getCoreVersion());
        if (!compatibility.compatible) {
            return {
                allowed: false,
                mode: 'strict',
                errorCode: 'validation-failed',
                reason: compatibility.reason || 'Module is incompatible with current core version',
            };
        }
        return { allowed: true, mode: 'strict' };
    }

    const shape = validateModuleInfoShape(infoToValidate);
    const compatibility = evaluateModuleCompatibility(infoToValidate, getCoreVersion());

    if (shape.valid && compatibility.compatible) {
        return { allowed: true, mode: 'strict' };
    }

    const reasons: string[] = [];
    if (!shape.valid) reasons.push(shape.errors.join('; '));
    if (!compatibility.compatible && compatibility.reason) reasons.push(compatibility.reason);
    const reason = reasons.join(' | ') || 'Manifest validation failed';
    const classification: ModuleLifecycleClassificationInput = shape.valid
        ? {
            status: 'incompatible',
            enabled: false,
            reason: compatibility.reason || reason,
            manifestValid: true,
            compatible: false,
            coreVersion: compatibility.coreVersion,
            requiredCoreVersion: compatibility.requiredCoreVersion,
            requiredApiContracts: compatibility.requiredApiContracts,
            providedApiContracts: compatibility.providedApiContracts,
            coreDiagnostics: compatibility.coreDiagnostics,
            contractDiagnostics: compatibility.contractDiagnostics,
        }
        : {
            status: 'errored',
            enabled: false,
            reason,
            manifestValid: false,
            validationErrors: shape.errors,
            compatible: compatibility.compatible,
            coreVersion: compatibility.coreVersion,
            requiredCoreVersion: compatibility.requiredCoreVersion,
            requiredApiContracts: compatibility.requiredApiContracts,
            providedApiContracts: compatibility.providedApiContracts,
            coreDiagnostics: compatibility.coreDiagnostics,
            contractDiagnostics: compatibility.contractDiagnostics,
        };

    if (isManifestFailOpenEnabled()) {
        return {
            allowed: true,
            mode: 'fail-open',
            reason: reason || 'Manifest gate bypassed in development fail-open mode',
        };
    }

    return {
        allowed: false,
        mode: 'strict',
        errorCode: 'validation-failed',
        reason,
        classification,
    };
}

export interface InstallManagedModuleInput {
    moduleId: string;
    source: string;
    version?: string;
    integrity?: string;
    signature?: string;
    permissions?: SystemModuleInfo['permissions'];
}

interface DryRunDependencyViolation {
    type: string;
    moduleId: string;
    affectedModule: string;
    reason: string;
}

interface DryRunDependencyImpact {
    canProceed: boolean;
    violations?: DryRunDependencyViolation[];
}

interface DryRunSourceResolution {
    ok: boolean;
    kind?: string;
    source?: string;
    version?: string;
    sourceRef?: string;
    error?: string;
}

interface DryRunManifestGate {
    allowed: boolean;
    mode: 'strict' | 'fail-open';
    reason?: string;
    errorCode?: 'module-not-found' | 'validation-failed';
}

export interface DryRunManagedModuleResult {
    success: true;
    moduleId: string;
    operation: 'dry-run-install' | 'dry-run-upgrade';
    wouldProceed: boolean;
    blockingReasons: string[];
    sourceResolution: DryRunSourceResolution;
    manifestGate: DryRunManifestGate;
    trustPolicy?: TrustPolicyDecision;
    artifactVerification: ArtifactVerificationOutcome;
    permissionDelta?: PermissionDeltaResult;
    dependencyImpact?: DryRunDependencyImpact;
}

type ManagerTelemetryOutcome = 'allow' | 'block' | 'error' | 'success';

interface ManagerTelemetryEvent {
    operation: 'install' | 'upgrade' | 'dry-run-install' | 'dry-run-upgrade';
    moduleId: string;
    stage:
    | 'source-resolution'
    | 'trust-policy'
    | 'manifest-gate'
    | 'artifact-verification'
    | 'permission-policy'
    | 'summary';
    outcome: ManagerTelemetryOutcome;
    sourceRef?: string;
    resolvedSource?: string;
    errorCode?: string;
    reason?: string;
    details?: Record<string, unknown>;
}

function emitManagerTelemetry(event: ManagerTelemetryEvent): void {
    const payload = JSON.stringify({
        component: 'module-manager',
        ...event,
    });
    const line = `[ModuleManagerTelemetry] ${payload}`;
    if (event.outcome === 'block' || event.outcome === 'error') {
        logger.warn(line);
        return;
    }
    logger.info(line);
}

function buildEffectiveModuleInfo(
    plugin: SystemPlugin | undefined,
    resolvedSource: ModuleSourceResolution,
    inputPermissions?: SystemModuleInfo['permissions']
): SystemModuleInfo | undefined {
    if (!plugin) {
        return {
            id: resolvedSource.moduleId,
            title: resolvedSource.moduleId,
            version: resolvedSource.version || '0.0.0',
            trust: resolvedSource.trustTier ? { tier: resolvedSource.trustTier } : { tier: (resolvedSource.kind === 'local' || resolvedSource.kind === 'indexed') ? 'unverified' : 'untrusted' },
            permissions: inputPermissions || resolvedSource.permissions,
            compatibility: resolvedSource.compatibility,
            dependencies: resolvedSource.dependencies,
            conflicts: resolvedSource.conflicts,
        } as SystemModuleInfo;
    }

    return {
        ...plugin.info,
        trust: resolvedSource.trustTier
            ? { tier: resolvedSource.trustTier }
            : plugin.info.trust,
        permissions: inputPermissions || resolvedSource.permissions || plugin.info.permissions,
        compatibility: resolvedSource.compatibility || plugin.info.compatibility,
        dependencies: resolvedSource.dependencies || plugin.info.dependencies,
        conflicts: resolvedSource.conflicts || plugin.info.conflicts,
    };
}

function evaluateDependencyConflictImpact(
    moduleId: string,
    info?: SystemModuleInfo
): DryRunDependencyImpact | undefined {
    if (!info) return undefined;

    const id = moduleId.toLowerCase();
    const violations: DryRunDependencyViolation[] = [];
    const enabledModules = new Set<string>();

    for (const record of Object.values(lifecycleStore.modules)) {
        if (record.enabled && record.status !== 'incompatible' && record.status !== 'errored') {
            enabledModules.add(record.moduleId.toLowerCase());
        }
    }

    if (info.dependencies && info.dependencies.length > 0) {
        for (const depId of info.dependencies) {
            const depIdLower = depId.toLowerCase();
            const depPlugin = pluginMap.get(depIdLower);

            if (!depPlugin) {
                violations.push({
                    type: 'missing-dependency',
                    moduleId: id,
                    affectedModule: depIdLower,
                    reason: `Required dependency "${depId}" not found in registry`,
                });
            } else if (!enabledModules.has(depIdLower)) {
                violations.push({
                    type: 'unmet-dependency',
                    moduleId: id,
                    affectedModule: depIdLower,
                    reason: `Required dependency "${depId}" is not enabled. Enable it first.`,
                });
            }
        }
    }

    if (info.conflicts && info.conflicts.length > 0) {
        for (const conflictId of info.conflicts) {
            const conflictIdLower = conflictId.toLowerCase();
            if (enabledModules.has(conflictIdLower)) {
                const conflictPlugin = pluginMap.get(conflictIdLower);
                const conflictTitle = conflictPlugin?.info.title || conflictId;
                violations.push({
                    type: 'conflicting-module',
                    moduleId: id,
                    affectedModule: conflictIdLower,
                    reason: `Module "${info.title}" conflicts with enabled module "${conflictTitle}". Disable it first.`,
                });
            }
        }
    }

    return {
        canProceed: violations.length === 0,
        violations: violations.length > 0 ? violations : undefined,
    };
}

function buildFailedVerificationOutcome(
    moduleId: string,
    operation: 'install' | 'upgrade',
    source: string,
    reason: string
): ArtifactVerificationOutcome {
    return {
        moduleId,
        operation,
        status: 'failed',
        verified: false,
        reason,
        source,
        checkedAt: Date.now(),
    };
}

export async function dryRunInstallManagedModule(input: InstallManagedModuleInput): Promise<DryRunManagedModuleResult> {
    if (!isInitialized()) initializeRegistry();

    const id = input.moduleId.toLowerCase();
    const resolvedSource = await resolveManagedSource(id, input.source, input.version);
    if (!resolvedSource.ok) {
        emitManagerTelemetry({
            operation: 'dry-run-install',
            moduleId: id,
            stage: 'source-resolution',
            outcome: 'error',
            sourceRef: input.source,
            errorCode: 'source-resolution-failed',
            reason: resolvedSource.error,
        });
        return {
            success: true,
            moduleId: id,
            operation: 'dry-run-install',
            wouldProceed: false,
            blockingReasons: [resolvedSource.error],
            sourceResolution: {
                ok: false,
                sourceRef: input.source,
                error: resolvedSource.error,
            },
            manifestGate: {
                allowed: false,
                mode: 'strict',
                reason: 'Source resolution failed',
                errorCode: 'validation-failed',
            },
            artifactVerification: buildFailedVerificationOutcome(id, 'install', input.source, resolvedSource.error),
        };
    }

    const plugin = pluginMap.get(id);
    const effectiveInfo = buildEffectiveModuleInfo(plugin, resolvedSource.value, input.permissions);
    const trustDecision = effectiveInfo
        ? evaluateTrustPolicy(effectiveInfo, getTrustPolicyConfig(), {
            env: process.env,
            operation: 'install',
        })
        : undefined;

    const manifestGate = checkManifestGate(id, effectiveInfo);
    const verification = verifyArtifactMetadata({
        moduleId: id,
        operation: 'install',
        source: resolvedSource.value.source,
        integrity: input.integrity || resolvedSource.value.integrity,
        signature: input.signature || resolvedSource.value.signature,
    });
    const dependencyImpact = evaluateDependencyConflictImpact(id, effectiveInfo);

    const blockingReasons: string[] = [];
    if (trustDecision && !trustDecision.allowed) {
        blockingReasons.push(trustDecision.reason || 'Module trust policy blocked install operation');
    }
    if (!manifestGate.allowed) {
        blockingReasons.push(manifestGate.reason || 'Manifest validation failed');
    }
    if (!verification.verified) {
        blockingReasons.push(verification.reason || 'Artifact verification failed');
    }
    if (dependencyImpact && !dependencyImpact.canProceed && dependencyImpact.violations) {
        blockingReasons.push(...dependencyImpact.violations.map((entry) => entry.reason));
    }

    emitManagerTelemetry({
        operation: 'dry-run-install',
        moduleId: id,
        stage: 'summary',
        outcome: blockingReasons.length === 0 ? 'allow' : 'block',
        sourceRef: input.source,
        resolvedSource: resolvedSource.value.source,
        details: {
            wouldProceed: blockingReasons.length === 0,
            blockingReasonCount: blockingReasons.length,
            trustAllowed: trustDecision?.allowed,
            manifestAllowed: manifestGate.allowed,
            artifactVerified: verification.verified,
            dependencyOk: dependencyImpact?.canProceed,
        },
    });

    return {
        success: true,
        moduleId: id,
        operation: 'dry-run-install',
        wouldProceed: blockingReasons.length === 0,
        blockingReasons,
        sourceResolution: {
            ok: true,
            kind: resolvedSource.value.kind,
            source: resolvedSource.value.source,
            version: input.version || resolvedSource.value.version,
            sourceRef: resolvedSource.value.sourceRef,
        },
        manifestGate: {
            allowed: manifestGate.allowed,
            mode: manifestGate.mode,
            reason: manifestGate.reason,
            errorCode: manifestGate.errorCode,
        },
        trustPolicy: trustDecision,
        artifactVerification: verification,
        dependencyImpact,
    };
}

export async function dryRunUpgradeManagedModule(input: UpgradeManagedModuleInput): Promise<DryRunManagedModuleResult> {
    if (!isInitialized()) initializeRegistry();

    const id = input.moduleId.toLowerCase();
    const resolvedSource = await resolveManagedSource(id, input.source, input.targetVersion);
    if (!resolvedSource.ok) {
        emitManagerTelemetry({
            operation: 'dry-run-upgrade',
            moduleId: id,
            stage: 'source-resolution',
            outcome: 'error',
            sourceRef: input.source,
            errorCode: 'source-resolution-failed',
            reason: resolvedSource.error,
        });
        return {
            success: true,
            moduleId: id,
            operation: 'dry-run-upgrade',
            wouldProceed: false,
            blockingReasons: [resolvedSource.error],
            sourceResolution: {
                ok: false,
                sourceRef: input.source,
                error: resolvedSource.error,
            },
            manifestGate: {
                allowed: false,
                mode: 'strict',
                reason: 'Source resolution failed',
                errorCode: 'validation-failed',
            },
            artifactVerification: buildFailedVerificationOutcome(id, 'upgrade', input.source, resolvedSource.error),
        };
    }

    const plugin = pluginMap.get(id);
    const effectiveInfo = buildEffectiveModuleInfo(plugin, resolvedSource.value, input.permissions);
    const trustDecision = effectiveInfo
        ? evaluateTrustPolicy(effectiveInfo, getTrustPolicyConfig(), {
            env: process.env,
            operation: 'upgrade',
        })
        : undefined;

    const manifestGate = checkManifestGate(id, effectiveInfo);
    const artifactStorePath = getArtifactStateFilePathOverride();
    const artifactStore = loadArtifactStore(artifactStorePath);
    const previousPermissions = getArtifact(artifactStore, id)?.permissions || plugin?.info.permissions;
    const requestedPermissions = input.permissions || resolvedSource.value.permissions || plugin?.info.permissions;
    const permissionDelta = evaluatePermissionDelta(previousPermissions, requestedPermissions);
    const verification = verifyArtifactMetadata({
        moduleId: id,
        operation: 'upgrade',
        source: resolvedSource.value.source,
        integrity: input.integrity || resolvedSource.value.integrity,
        signature: input.signature || resolvedSource.value.signature,
    });
    const dependencyImpact = evaluateDependencyConflictImpact(id, effectiveInfo);

    const requiresEscalationApproval = permissionDelta.escalated
        && getTrustPolicyConfig().requirePermissionEscalationApproval
        && !input.approvePermissionEscalation;

    const blockingReasons: string[] = [];
    if (trustDecision && !trustDecision.allowed) {
        blockingReasons.push(trustDecision.reason || 'Module trust policy blocked upgrade operation');
    }
    if (!manifestGate.allowed) {
        blockingReasons.push(manifestGate.reason || 'Manifest validation failed');
    }
    if (requiresEscalationApproval) {
        emitManagerTelemetry({
            operation: 'dry-run-upgrade',
            moduleId: id,
            stage: 'permission-policy',
            outcome: 'block',
            sourceRef: input.source,
            resolvedSource: resolvedSource.value.source,
            errorCode: 'permission-escalation-requires-approval',
            reason: `Permission escalation requires explicit approval: ${permissionDelta.escalations.map((entry) => entry.change).join('; ')}`,
        });
        blockingReasons.push(`Permission escalation requires explicit approval: ${permissionDelta.escalations.map((entry) => entry.change).join('; ')}`);
    }
    if (!verification.verified) {
        blockingReasons.push(verification.reason || 'Artifact verification failed');
    }
    if (dependencyImpact && !dependencyImpact.canProceed && dependencyImpact.violations) {
        blockingReasons.push(...dependencyImpact.violations.map((entry) => entry.reason));
    }

    emitManagerTelemetry({
        operation: 'dry-run-upgrade',
        moduleId: id,
        stage: 'summary',
        outcome: blockingReasons.length === 0 ? 'allow' : 'block',
        sourceRef: input.source,
        resolvedSource: resolvedSource.value.source,
        details: {
            wouldProceed: blockingReasons.length === 0,
            blockingReasonCount: blockingReasons.length,
            trustAllowed: trustDecision?.allowed,
            manifestAllowed: manifestGate.allowed,
            artifactVerified: verification.verified,
            dependencyOk: dependencyImpact?.canProceed,
            permissionEscalated: permissionDelta.escalated,
            escalationApproved: input.approvePermissionEscalation === true,
        },
    });

    return {
        success: true,
        moduleId: id,
        operation: 'dry-run-upgrade',
        wouldProceed: blockingReasons.length === 0,
        blockingReasons,
        sourceResolution: {
            ok: true,
            kind: resolvedSource.value.kind,
            source: resolvedSource.value.source,
            version: input.targetVersion || resolvedSource.value.version,
            sourceRef: resolvedSource.value.sourceRef,
        },
        manifestGate: {
            allowed: manifestGate.allowed,
            mode: manifestGate.mode,
            reason: manifestGate.reason,
            errorCode: manifestGate.errorCode,
        },
        trustPolicy: trustDecision,
        artifactVerification: verification,
        permissionDelta,
        dependencyImpact,
    };
}

export async function installManagedModule(input: InstallManagedModuleInput): Promise<ManagerOperationResult> {
    if (!isInitialized()) initializeRegistry();

    const id = input.moduleId.toLowerCase();
    const resolvedSource = await resolveManagedSource(id, input.source, input.version);
    if (!resolvedSource.ok) {
        emitManagerTelemetry({
            operation: 'install',
            moduleId: id,
            stage: 'source-resolution',
            outcome: 'error',
            sourceRef: input.source,
            errorCode: 'source-resolution-failed',
            reason: resolvedSource.error,
        });
        return operationFailure(
            id,
            'install',
            resolvedSource.error,
            undefined,
            'source-resolution-failed'
        );
    }

    const plugin = pluginMap.get(id);
    const artifactStorePath = getArtifactStateFilePathOverride();
    const artifactStore = loadArtifactStore(artifactStorePath);
    const existingArtifact = getArtifact(artifactStore, id);

    // Block install over built-in or manually-placed data/ modules.
    // Local-dev modules (source === 'local') are superseded by managed installs.
    if (plugin && !existingArtifact && plugin.source !== 'local') {
        return operationFailure(
            id,
            'install',
            'Cannot install over an unmanaged (built-in or manual) module. Management operations are disabled for local system modules.',
            undefined,
            'unmanaged-module-protection'
        );
    }

    const effectiveInfo = buildEffectiveModuleInfo(plugin, resolvedSource.value, input.permissions);
    if (effectiveInfo) {
        const trustDecision = evaluateTrustPolicy(effectiveInfo, getTrustPolicyConfig(), {
            env: process.env,
            operation: 'install',
        });
        if (!trustDecision.allowed) {
            emitManagerTelemetry({
                operation: 'install',
                moduleId: id,
                stage: 'trust-policy',
                outcome: 'block',
                sourceRef: input.source,
                resolvedSource: resolvedSource.value.source,
                errorCode: 'trust-policy-blocked',
                reason: trustDecision.reason,
            });
            return operationFailure(
                id,
                'install',
                trustDecision.reason || 'Module trust policy blocked install operation',
                undefined,
                'trust-policy-blocked'
            );
        }
    }

    const gate = checkManifestGate(id, effectiveInfo);
    if (!gate.allowed) {
        emitManagerTelemetry({
            operation: 'install',
            moduleId: id,
            stage: 'manifest-gate',
            outcome: 'block',
            sourceRef: input.source,
            resolvedSource: resolvedSource.value.source,
            errorCode: gate.errorCode || 'validation-failed',
            reason: gate.reason,
        });
        if (gate.classification) {
            applyLifecycleClassification(lifecycleStore, id, gate.classification);
            saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
        }
        return operationFailure(
            id,
            'install',
            gate.reason || 'Manifest validation failed',
            undefined,
            gate.errorCode || 'validation-failed'
        );
    }
    if (gate.mode === 'fail-open' && gate.reason) {
        logger.warn(`[ModuleManager] Manifest gate fail-open for "${id}": ${gate.reason}`);
    }

    const verification = verifyArtifactMetadata({
        moduleId: id,
        operation: 'install',
        source: resolvedSource.value.source,
        integrity: input.integrity || resolvedSource.value.integrity,
        signature: input.signature || resolvedSource.value.signature,
    });
    upsertArtifactVerification(artifactStore, verification);
    saveArtifactStore(artifactStore, artifactStorePath);
    if (!verification.verified) {
        emitManagerTelemetry({
            operation: 'install',
            moduleId: id,
            stage: 'artifact-verification',
            outcome: 'block',
            sourceRef: input.source,
            resolvedSource: resolvedSource.value.source,
            errorCode: 'artifact-verification-failed',
            reason: verification.reason,
        });
        return operationFailure(
            id,
            'install',
            verification.reason || 'Artifact verification failed',
            undefined,
            'artifact-verification-failed'
        );
    }

    const managerInput: InstallModuleInput = {
        moduleId: id,
        source: resolvedSource.value.source,
        version: input.version || resolvedSource.value.version,
        integrity: input.integrity || resolvedSource.value.integrity,
        signature: input.signature || resolvedSource.value.signature,
        permissions: input.permissions || resolvedSource.value.permissions || plugin?.info.permissions,
    };

    const result = await installModule(
        id,
        managerInput,
        lifecycleStore,
        artifactStore,
        Date.now(),
        getLifecycleStateFilePathOverride(),
        artifactStorePath
    );

    emitManagerTelemetry({
        operation: 'install',
        moduleId: id,
        stage: 'summary',
        outcome: result.success ? 'success' : 'error',
        sourceRef: input.source,
        resolvedSource: resolvedSource.value.source,
        errorCode: result.errorCode,
        reason: result.error,
    });

    if (result.success) {
        refreshRegistry();
    }

    return result;
}

export interface UpgradeManagedModuleInput {
    moduleId: string;
    source: string;
    targetVersion?: string;
    integrity?: string;
    signature?: string;
    permissions?: SystemModuleInfo['permissions'];
    approvePermissionEscalation?: boolean;
}

export async function upgradeManagedModule(input: UpgradeManagedModuleInput): Promise<ManagerOperationResult> {
    if (!isInitialized()) initializeRegistry();

    const id = input.moduleId.toLowerCase();
    const resolvedSource = await resolveManagedSource(id, input.source, input.targetVersion);
    if (!resolvedSource.ok) {
        emitManagerTelemetry({
            operation: 'upgrade',
            moduleId: id,
            stage: 'source-resolution',
            outcome: 'error',
            sourceRef: input.source,
            errorCode: 'source-resolution-failed',
            reason: resolvedSource.error,
        });
        return operationFailure(
            id,
            'upgrade',
            resolvedSource.error,
            undefined,
            'source-resolution-failed'
        );
    }

    const plugin = pluginMap.get(id);
    const artifactStorePath = getArtifactStateFilePathOverride();
    const artifactStore = loadArtifactStore(artifactStorePath);
    const existingArtifact = getArtifact(artifactStore, id);

    // Protection for unmanaged modules
    if (plugin && !existingArtifact) {
        return operationFailure(
            id,
            'upgrade',
            'Cannot upgrade an unmanaged (built-in or manual) module. Management operations are disabled for local system modules.',
            undefined,
            'unmanaged-module-protection'
        );
    }

    const effectiveInfo = buildEffectiveModuleInfo(plugin, resolvedSource.value, input.permissions);
    if (effectiveInfo) {
        const trustDecision = evaluateTrustPolicy(effectiveInfo, getTrustPolicyConfig(), {
            env: process.env,
            operation: 'upgrade',
        });
        if (!trustDecision.allowed) {
            emitManagerTelemetry({
                operation: 'upgrade',
                moduleId: id,
                stage: 'trust-policy',
                outcome: 'block',
                sourceRef: input.source,
                resolvedSource: resolvedSource.value.source,
                errorCode: 'trust-policy-blocked',
                reason: trustDecision.reason,
            });
            return operationFailure(
                id,
                'upgrade',
                trustDecision.reason || 'Module trust policy blocked upgrade operation',
                undefined,
                'trust-policy-blocked'
            );
        }
    }

    const gate = checkManifestGate(id, effectiveInfo);
    if (!gate.allowed) {
        emitManagerTelemetry({
            operation: 'upgrade',
            moduleId: id,
            stage: 'manifest-gate',
            outcome: 'block',
            sourceRef: input.source,
            resolvedSource: resolvedSource.value.source,
            errorCode: gate.errorCode || 'validation-failed',
            reason: gate.reason,
        });
        if (gate.classification) {
            applyLifecycleClassification(lifecycleStore, id, gate.classification);
            saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
        }
        return operationFailure(
            id,
            'upgrade',
            gate.reason || 'Manifest validation failed',
            undefined,
            gate.errorCode || 'validation-failed'
        );
    }
    if (gate.mode === 'fail-open' && gate.reason) {
        logger.warn(`[ModuleManager] Manifest gate fail-open for "${id}": ${gate.reason}`);
    }

    const previousPermissions = getArtifact(artifactStore, id)?.permissions || plugin?.info.permissions;
    const requestedPermissions = input.permissions || resolvedSource.value.permissions || plugin?.info.permissions;
    const permissionDelta = evaluatePermissionDelta(previousPermissions, requestedPermissions);
    if (permissionDelta.escalated && getTrustPolicyConfig().requirePermissionEscalationApproval && !input.approvePermissionEscalation) {
        emitManagerTelemetry({
            operation: 'upgrade',
            moduleId: id,
            stage: 'permission-policy',
            outcome: 'block',
            sourceRef: input.source,
            resolvedSource: resolvedSource.value.source,
            errorCode: 'permission-escalation-requires-approval',
            reason: `Permission escalation requires explicit approval: ${permissionDelta.escalations.map((entry) => entry.change).join('; ')}`,
        });
        return operationFailure(
            id,
            'upgrade',
            `Permission escalation requires explicit approval: ${permissionDelta.escalations.map((entry) => entry.change).join('; ')}`,
            undefined,
            'permission-escalation-requires-approval'
        );
    }

    const verification = verifyArtifactMetadata({
        moduleId: id,
        operation: 'upgrade',
        source: resolvedSource.value.source,
        integrity: input.integrity || resolvedSource.value.integrity,
        signature: input.signature || resolvedSource.value.signature,
    });
    upsertArtifactVerification(artifactStore, verification);
    saveArtifactStore(artifactStore, artifactStorePath);
    if (!verification.verified) {
        emitManagerTelemetry({
            operation: 'upgrade',
            moduleId: id,
            stage: 'artifact-verification',
            outcome: 'block',
            sourceRef: input.source,
            resolvedSource: resolvedSource.value.source,
            errorCode: 'artifact-verification-failed',
            reason: verification.reason,
        });
        return operationFailure(
            id,
            'upgrade',
            verification.reason || 'Artifact verification failed',
            undefined,
            'artifact-verification-failed'
        );
    }

    const managerInput: UpgradeModuleInput = {
        source: resolvedSource.value.source,
        targetVersion: input.targetVersion || resolvedSource.value.version,
        integrity: input.integrity || resolvedSource.value.integrity,
        signature: input.signature || resolvedSource.value.signature,
        permissions: requestedPermissions,
    };

    const result = await upgradeModule(
        id,
        managerInput,
        lifecycleStore,
        artifactStore,
        Date.now(),
        getLifecycleStateFilePathOverride(),
        artifactStorePath
    );

    emitManagerTelemetry({
        operation: 'upgrade',
        moduleId: id,
        stage: 'summary',
        outcome: result.success ? 'success' : 'error',
        sourceRef: input.source,
        resolvedSource: resolvedSource.value.source,
        errorCode: result.errorCode,
        reason: result.error,
    });

    if (result.success) {
        refreshRegistry();
    }

    return result;
}

export function uninstallManagedModule(moduleId: string): ManagerOperationResult {
    if (!isInitialized()) initializeRegistry();

    const id = moduleId.toLowerCase();
    const plugin = pluginMap.get(id);
    const artifactStorePath = getArtifactStateFilePathOverride();
    const artifactStore = loadArtifactStore(artifactStorePath);
    const existingArtifact = getArtifact(artifactStore, id);

    // Protection for unmanaged modules
    if (plugin && !existingArtifact) {
        return operationFailure(
            id,
            'uninstall',
            'Cannot uninstall an unmanaged (built-in or manual) module. These modules must be removed manually from the filesystem.',
            undefined,
            'unmanaged-module-protection'
        );
    }

    const result = uninstallModule(
        id,
        lifecycleStore,
        artifactStore,
        Date.now(),
        getLifecycleStateFilePathOverride(),
        artifactStorePath
    );

    if (result.success) {
        // Physical file cleanup for managed modules in the data directory
        let dataDir = getModulesDataDir();
        let pluginDir = plugin?.directory;

        try {
            dataDir = fs.realpathSync(dataDir);
            if (pluginDir) pluginDir = fs.realpathSync(pluginDir);
        } catch {
            dataDir = path.resolve(dataDir);
            if (pluginDir) pluginDir = path.resolve(pluginDir);
        }

        if (pluginDir && pluginDir.startsWith(dataDir)) {
            try {
                if (fs.existsSync(pluginDir)) {
                    fs.rmSync(pluginDir, { recursive: true, force: true });
                    logger.info(`Registry | Physically removed module directory: ${pluginDir}`);
                }
            } catch (err) {
                logger.error(`Registry | Failed to remove module directory ${pluginDir}:`, err);
            }
        }

        refreshRegistry();
    }

    return result;
}

export function validateManagedModule(moduleId: string): ManagerOperationResult {
    if (!isInitialized()) initializeRegistry();

    const id = moduleId.toLowerCase();
    const record = getLifecycleRecord(id);
    if (!record) {
        return operationFailure(id, 'validate', 'Module record not found in lifecycle store', undefined, 'module-not-found');
    }

    const plugin = pluginMap.get(id);
    if (!plugin) {
        if (record.validation && (!record.validation.manifestValid || !record.validation.compatible)) {
            return operationFailure(
                id,
                'validate',
                record.reason || 'Module validation failed',
                record.status,
                'validation-failed'
            );
        }
        return operationFailure(id, 'validate', `Module ${id} not found in registry`, record.status, 'module-not-found');
    }

    const previousStatus = record.status;
    const shape = validateModuleInfoShape(plugin.info);
    const compatibility = evaluateModuleCompatibility(plugin.info, getCoreVersion());

    if (!shape.valid) {
        applyLifecycleClassification(lifecycleStore, id, {
            status: 'errored',
            enabled: false,
            reason: shape.errors.join('; '),
            manifestValid: false,
            validationErrors: shape.errors,
            compatible: false,
            coreVersion: getCoreVersion(),
        });
        saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
        return operationFailure(id, 'validate', shape.errors.join('; '), previousStatus, 'validation-failed');
    }

    if (!compatibility.compatible) {
        const reason = compatibility.reason || 'Module is incompatible with current core version';
        applyLifecycleClassification(lifecycleStore, id, {
            status: 'incompatible',
            enabled: false,
            reason,
            manifestValid: true,
            compatible: false,
            coreVersion: compatibility.coreVersion,
            requiredCoreVersion: compatibility.requiredCoreVersion,
            requiredApiContracts: compatibility.requiredApiContracts,
            providedApiContracts: compatibility.providedApiContracts,
            coreDiagnostics: compatibility.coreDiagnostics,
            contractDiagnostics: compatibility.contractDiagnostics,
        });
        saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
        return operationFailure(id, 'validate', reason, previousStatus, 'validation-failed');
    }

    const current = lifecycleStore.modules[id];
    const enabled = current?.enabled ?? false;
    const nextStatus: ModuleLifecycleStatus = enabled ? 'validated' : 'disabled';
    applyLifecycleClassification(lifecycleStore, id, {
        status: nextStatus,
        enabled,
        reason: undefined,
        manifestValid: true,
        compatible: true,
        coreVersion: compatibility.coreVersion,
        requiredCoreVersion: compatibility.requiredCoreVersion,
        requiredApiContracts: compatibility.requiredApiContracts,
        providedApiContracts: compatibility.providedApiContracts,
        coreDiagnostics: compatibility.coreDiagnostics,
        contractDiagnostics: compatibility.contractDiagnostics,
    });
    saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());

    return operationSuccess(id, 'validate', previousStatus, nextStatus);
}

export function __resetRegistryForTests() {
    pluginMap.clear();
    adapterInstances.clear();
    lifecycleStore.version = 1;
    lifecycleStore.modules = {};
    setInitialized(false);
}

/**
 * Check if a module can be enabled based on dependency constraints.
 * Returns violations if dependencies are not met or conflicts exist.
 */
export function checkCanEnableModule(moduleId: string): {
    canEnable: boolean;
    violations?: Array<{ type: string; moduleId: string; affectedModule: string; reason: string }>;
} {
    if (!isInitialized()) initializeRegistry();

    const id = moduleId.toLowerCase();
    const modulePlugin = pluginMap.get(id);

    if (!modulePlugin) {
        return {
            canEnable: false,
            violations: [
                {
                    type: 'module-not-found',
                    moduleId: id,
                    affectedModule: id,
                    reason: `Module ${moduleId} not found in registry`
                }
            ]
        };
    }

    const moduleInfo = modulePlugin.info;
    const violations: Array<{ type: string; moduleId: string; affectedModule: string; reason: string }> = [];
    const enabledModules = new Set<string>();

    // Build set of enabled modules
    for (const record of Object.values(lifecycleStore.modules)) {
        if (record.enabled && record.status !== 'incompatible' && record.status !== 'errored') {
            enabledModules.add(record.moduleId.toLowerCase());
        }
    }

    // Check dependencies
    if (moduleInfo.dependencies && moduleInfo.dependencies.length > 0) {
        for (const depId of moduleInfo.dependencies) {
            const depIdLower = depId.toLowerCase();
            const depPlugin = pluginMap.get(depIdLower);

            if (!depPlugin) {
                violations.push({
                    type: 'missing-dependency',
                    moduleId: id,
                    affectedModule: depIdLower,
                    reason: `Required dependency "${depId}" not found in registry`
                });
            } else if (!enabledModules.has(depIdLower)) {
                violations.push({
                    type: 'unmet-dependency',
                    moduleId: id,
                    affectedModule: depIdLower,
                    reason: `Required dependency "${depId}" is not enabled. Enable it first.`
                });
            }
        }
    }

    // Check conflicts
    if (moduleInfo.conflicts && moduleInfo.conflicts.length > 0) {
        for (const conflictId of moduleInfo.conflicts) {
            const conflictIdLower = conflictId.toLowerCase();
            if (enabledModules.has(conflictIdLower)) {
                const conflictPlugin = pluginMap.get(conflictIdLower);
                const conflictTitle = conflictPlugin?.info.title || conflictId;
                violations.push({
                    type: 'conflicting-module',
                    moduleId: id,
                    affectedModule: conflictIdLower,
                    reason: `Module "${moduleInfo.title}" conflicts with enabled module "${conflictTitle}". Disable it first.`
                });
            }
        }
    }

    return {
        canEnable: violations.length === 0,
        violations: violations.length > 0 ? violations : undefined
    };
}

/**
 * Check if a module can be disabled without breaking dependent modules.
 * Returns violations if other modules depend on this one.
 */
export function checkCanDisableModule(moduleId: string): {
    canDisable: boolean;
    violations?: Array<{ type: string; moduleId: string; affectedModule: string; reason: string }>;
} {
    if (!isInitialized()) initializeRegistry();

    const id = moduleId.toLowerCase();
    const modulePlugin = pluginMap.get(id);
    const moduleInfo = modulePlugin?.info;
    const moduleTitle = moduleInfo?.title || moduleId;
    const violations: Array<{ type: string; moduleId: string; affectedModule: string; reason: string }> = [];
    const enabledModules = new Set<string>();

    // Build set of enabled modules
    for (const record of Object.values(lifecycleStore.modules)) {
        if (record.enabled && record.status !== 'incompatible' && record.status !== 'errored') {
            enabledModules.add(record.moduleId.toLowerCase());
        }
    }

    // Find all enabled modules that depend on this one
    for (const [otherModuleId, plugin] of pluginMap.entries()) {
        if (otherModuleId === id) continue;
        if (!enabledModules.has(otherModuleId)) continue;

        const otherInfo = plugin.info;
        if (otherInfo.dependencies && otherInfo.dependencies.some(d => d.toLowerCase() === id)) {
            violations.push({
                type: 'has-dependents',
                moduleId: id,
                affectedModule: otherModuleId,
                reason: `Module "${otherInfo.title}" requires "${moduleTitle}" to be enabled. Disable "${otherInfo.title}" first.`
            });
        }
    }

    return {
        canDisable: violations.length === 0,
        violations: violations.length > 0 ? violations : undefined
    };
}

/**
 * Returns all discovered system manifests.
 * Used by the Core Service to expose available systems to the frontend.
 */
export function getRegisteredModules(options?: { includeExperimental?: boolean }) {
    return listModules({ includeExperimental: options?.includeExperimental, includeDisabled: true })
        .map((entry) => entry.info);
}

/**
 * Returns a map of moduleId → activeSource for all discovered modules.
 * 'local' means the dev source in data/local/modules is active;
 * 'data' means the managed install in data/modules is active;
 * 'built-in' means the module lives in src/modules.
 * Used by the client's getUIModule to pick the correct import alias.
 */
export function getModuleActiveSources(): Record<string, 'local' | 'data' | 'built-in'> {
    const result: Record<string, 'local' | 'data' | 'built-in'> = {};
    for (const [id, plugin] of pluginMap.entries()) {
        const record = lifecycleStore.modules[id];
        const activeSource = record?.activeSource ?? plugin.source;
        if (activeSource === 'local' || activeSource === 'data' || activeSource === 'built-in') {
            result[id] = activeSource;
        }
    }
    return result;
}

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

        // Optional initialization hook — inject ModuleContext so adapters
        // have access to a namespaced logger, scoped cache, and discovery.
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
