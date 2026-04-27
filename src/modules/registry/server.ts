import { hasInitialize, SystemAdapter, SystemModuleInfo, SystemPlugin } from './types';
export * from './utils';
import { logger } from '@shared/utils/logger';
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
} from './lifecycle';
import { evaluateModuleCompatibility, validateModuleInfoShape } from './validation';
import {
    installModule,
    uninstallModule,
    upgradeModule,
    operationFailure,
    operationSuccess,
    type InstallModuleInput,
    type UpgradeModuleInput,
    type ManagerOperationResult,
} from './manager';
import { getArtifact, loadArtifactStore, saveArtifactStore, upsertArtifactVerification } from './artifactStore';
import {
    evaluateTrustPolicy,
    getDefaultModuleTrustPolicy,
    type ModuleTrustPolicyConfig,
    type TrustPolicyDecision,
} from './trustPolicy';
import { getConfig } from '@server/core/config';
import { verifyArtifactMetadata, type ArtifactVerificationOutcome } from './artifactVerification';
import { evaluatePermissionDelta, type PermissionDeltaResult } from './permissionPolicy';
import {
    getDefaultModuleSourceAdapters,
    resolveModuleSource,
    type ModuleSourceResolution,
    type SourceResolutionContext,
} from './sourceAdapters';
import { validateModuleIndexDocument, type ModuleIndexDocument } from './moduleIndex';

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
}

interface RegistryState {
    pluginMap: Map<string, SystemPlugin>;
    adapterInstances: Map<string, any>;
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
            isInitialized: false,
            lifecycleStore: createEmptyLifecycleStore()
        };
    }
    return g.__coreRegistry;
};

const _state = getGlobalState();
const pluginMap = _state.pluginMap;
const adapterInstances = _state.adapterInstances;
const lifecycleStore = _state.lifecycleStore;
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

function buildSourceResolutionContext(sourceRef: string): { ok: true; context?: SourceResolutionContext } | { ok: false; error: string } {
    if (!sourceRef.startsWith('index://')) {
        return { ok: true };
    }

    const indexFilePath = process.env[MODULE_INDEX_FILE_ENV];
    if (!indexFilePath || !indexFilePath.trim()) {
        return {
            ok: false,
            error: `Index source "${sourceRef}" requires ${MODULE_INDEX_FILE_ENV} to be set`,
        };
    }

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

function resolveManagedSource(moduleId: string, sourceRef: string, targetVersion?: string): { ok: true; value: ModuleSourceResolution } | { ok: false; error: string } {
    const contextResult = buildSourceResolutionContext(sourceRef);
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

        const modulesDir = path.join(process.cwd(), 'src', 'modules');
        logger.info(`Registry [PID:${process.pid}] | Scanning modules directory: ${modulesDir} (CWD: ${process.cwd()})`);

        if (!fs.existsSync(modulesDir)) {
            logger.error(`Registry [PID:${process.pid}] | Modules directory NOT FOUND at: ${modulesDir}`);
            return;
        }

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
                    directory: entry.name
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
                    directory: entry.name
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
                    directory: entry.name,
                    // Thunk-based lazy loading for system modules
                    getLogic: () => import(`@modules/${entry.name}/${info.manifest.logic}`),
                    getUI: () => import(`@modules/${entry.name}/${info.manifest.ui}`),
                    getServer: info.manifest.server ? () => import(`@modules/${entry.name}/${info.manifest.server}`) : undefined
                };

                const primaryId = info.id.toLowerCase();
                pluginMap.set(primaryId, plugin);
                const existingLifecycle = lifecycleStore.modules[primaryId];
                const enabled = existingLifecycle ? existingLifecycle.enabled : true;
                applyLifecycleClassification(lifecycleStore, primaryId, {
                    status: enabled ? 'validated' : 'disabled',
                    enabled,
                    reason: enabled ? undefined : 'Module disabled in persisted lifecycle state',
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
                logger.error(`Registry | Failed to parse manifest for "${entry.name}":`, err);
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

export function listModules(options?: { includeExperimental?: boolean; includeDisabled?: boolean }): RegisteredModuleRuntimeInfo[] {
    if (!isInitialized()) initializeRegistry();

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

            return {
                info: plugin.info,
                directory: plugin.directory,
                lifecycle,
                enabled: lifecycle.enabled,
                status: lifecycle.status,
                reason: lifecycle.reason
            };
        })
        .filter((entry) => options?.includeDisabled || entry.enabled);
}

export function disableModule(moduleId: string, reason = 'Module disabled by operator'): boolean {
    if (!isInitialized()) initializeRegistry();
    const id = moduleId.toLowerCase();

    if (id === 'generic') {
        logger.warn('Registry | Refusing to disable generic module');
        return false;
    }

    const record = getLifecycleRecord(id);
    if (!record) return false;

    record.enabled = false;
    record.status = 'disabled';
    record.reason = reason;
    record.updatedAt = Date.now();

    unloadSystemModules(id);
    saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
    return true;
}

export function enableModule(moduleId: string): boolean {
    if (!isInitialized()) initializeRegistry();
    const id = moduleId.toLowerCase();
    const record = getLifecycleRecord(id);
    if (!record) return false;

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
    record.status = 'validated';
    record.reason = undefined;
    record.updatedAt = Date.now();

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

function checkManifestGate(moduleId: string): ManifestGateResult {
    const id = moduleId.toLowerCase();
    const plugin = pluginMap.get(id);
    const record = getLifecycleRecord(id);

    if (!plugin) {
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

        return {
            allowed: false,
            mode: 'strict',
            errorCode: 'module-not-found',
            reason: `Module ${id} not found in registry`,
        };
    }

    const shape = validateModuleInfoShape(plugin.info);
    const compatibility = evaluateModuleCompatibility(plugin.info, getCoreVersion());

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

function buildEffectiveModuleInfo(
    plugin: SystemPlugin | undefined,
    resolvedSource: ModuleSourceResolution,
    inputPermissions?: SystemModuleInfo['permissions']
): SystemModuleInfo | undefined {
    if (!plugin) return undefined;

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

export function dryRunInstallManagedModule(input: InstallManagedModuleInput): DryRunManagedModuleResult {
    if (!isInitialized()) initializeRegistry();

    const id = input.moduleId.toLowerCase();
    const resolvedSource = resolveManagedSource(id, input.source, input.version);
    if (!resolvedSource.ok) {
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

    const manifestGate = checkManifestGate(id);
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

export function dryRunUpgradeManagedModule(input: UpgradeManagedModuleInput): DryRunManagedModuleResult {
    if (!isInitialized()) initializeRegistry();

    const id = input.moduleId.toLowerCase();
    const resolvedSource = resolveManagedSource(id, input.source, input.targetVersion);
    if (!resolvedSource.ok) {
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

    const manifestGate = checkManifestGate(id);
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
        blockingReasons.push(`Permission escalation requires explicit approval: ${permissionDelta.escalations.map((entry) => entry.change).join('; ')}`);
    }
    if (!verification.verified) {
        blockingReasons.push(verification.reason || 'Artifact verification failed');
    }
    if (dependencyImpact && !dependencyImpact.canProceed && dependencyImpact.violations) {
        blockingReasons.push(...dependencyImpact.violations.map((entry) => entry.reason));
    }

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

export function installManagedModule(input: InstallManagedModuleInput): ManagerOperationResult {
    if (!isInitialized()) initializeRegistry();

    const id = input.moduleId.toLowerCase();
    const resolvedSource = resolveManagedSource(id, input.source, input.version);
    if (!resolvedSource.ok) {
        return operationFailure(
            id,
            'install',
            resolvedSource.error,
            undefined,
            'source-resolution-failed'
        );
    }

    const plugin = pluginMap.get(id);
    const effectiveInfo = buildEffectiveModuleInfo(plugin, resolvedSource.value, input.permissions);
    if (effectiveInfo) {
        const trustDecision = evaluateTrustPolicy(effectiveInfo, getTrustPolicyConfig(), {
            env: process.env,
            operation: 'install',
        });
        if (!trustDecision.allowed) {
            return operationFailure(
                id,
                'install',
                trustDecision.reason || 'Module trust policy blocked install operation',
                undefined,
                'trust-policy-blocked'
            );
        }
    }

    const gate = checkManifestGate(id);
    if (!gate.allowed) {
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

    const artifactStorePath = getArtifactStateFilePathOverride();
    const artifactStore = loadArtifactStore(artifactStorePath);

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

    return installModule(
        id,
        managerInput,
        lifecycleStore,
        artifactStore,
        Date.now(),
        getLifecycleStateFilePathOverride(),
        artifactStorePath
    );
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

export function upgradeManagedModule(input: UpgradeManagedModuleInput): ManagerOperationResult {
    if (!isInitialized()) initializeRegistry();

    const id = input.moduleId.toLowerCase();
    const resolvedSource = resolveManagedSource(id, input.source, input.targetVersion);
    if (!resolvedSource.ok) {
        return operationFailure(
            id,
            'upgrade',
            resolvedSource.error,
            undefined,
            'source-resolution-failed'
        );
    }

    const plugin = pluginMap.get(id);
    const effectiveInfo = buildEffectiveModuleInfo(plugin, resolvedSource.value, input.permissions);
    if (effectiveInfo) {
        const trustDecision = evaluateTrustPolicy(effectiveInfo, getTrustPolicyConfig(), {
            env: process.env,
            operation: 'upgrade',
        });
        if (!trustDecision.allowed) {
            return operationFailure(
                id,
                'upgrade',
                trustDecision.reason || 'Module trust policy blocked upgrade operation',
                undefined,
                'trust-policy-blocked'
            );
        }
    }

    const gate = checkManifestGate(id);
    if (!gate.allowed) {
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

    const artifactStorePath = getArtifactStateFilePathOverride();
    const artifactStore = loadArtifactStore(artifactStorePath);
    const previousPermissions = getArtifact(artifactStore, id)?.permissions || plugin?.info.permissions;
    const requestedPermissions = input.permissions || resolvedSource.value.permissions || plugin?.info.permissions;
    const permissionDelta = evaluatePermissionDelta(previousPermissions, requestedPermissions);
    if (permissionDelta.escalated && getTrustPolicyConfig().requirePermissionEscalationApproval && !input.approvePermissionEscalation) {
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

    return upgradeModule(
        id,
        managerInput,
        lifecycleStore,
        artifactStore,
        Date.now(),
        getLifecycleStateFilePathOverride(),
        artifactStorePath
    );
}

export function uninstallManagedModule(moduleId: string): ManagerOperationResult {
    if (!isInitialized()) initializeRegistry();

    const id = moduleId.toLowerCase();
    const artifactStorePath = getArtifactStateFilePathOverride();
    const artifactStore = loadArtifactStore(artifactStorePath);

    return uninstallModule(
        id,
        lifecycleStore,
        artifactStore,
        Date.now(),
        getLifecycleStateFilePathOverride(),
        artifactStorePath
    );
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
 * JIT Logic Adapter Loader
 * Loads and instantiates the Logic Adapter for a given systemId.
 */
export async function getAdapter(systemId: string): Promise<SystemAdapter | null> {
    const id = systemId.toLowerCase();

    if (!isModuleEnabledForRuntime(id) && pluginMap.has(id)) {
        logger.warn(`Registry | Module ${id} is disabled or unavailable due to lifecycle state`);
        return null;
    }

    // Return cached instance if available
    if (adapterInstances.has(id)) return adapterInstances.get(id)!;

    // Ensure discovery has run
    if (!isInitialized()) initializeRegistry();

    const plugin = pluginMap.get(id) || pluginMap.get('generic');
    if (!plugin) return null;

    const pluginId = plugin.info.id.toLowerCase();
    if (!isModuleEnabledForRuntime(pluginId)) {
        logger.warn(`Registry | Refusing to instantiate disabled/incompatible module ${pluginId}`);
        return null;
    }

    try {
        const logicModule = await plugin.getLogic();
        const AdapterClass = logicModule.Adapter || logicModule.default;

        if (!AdapterClass) {
            logger.error(`Registry | No Adapter class found for ${id}`);
            recordLifecycleRuntimeFailure(lifecycleStore, pluginId, 'No Adapter class found in logic module export');
            saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
            return null;
        }

        const adapter = new AdapterClass();

        // Optional initialization hook for adapters (e.g., cache warming)
        if (hasInitialize(adapter)) {
            await adapter.initialize();
        }

        adapterInstances.set(id, adapter);
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
    } else {
        logger.info('Registry | Purging all active module instances');
        adapterInstances.clear();
    }
}

/**
 * Asynchronously finds the correct adapter for an actor object based on matching rules.
 */
export async function getMatchingAdapter(actor: any): Promise<SystemAdapter> {
    const genericAdapter = (await getAdapter('generic'))!;
    if (!actor) return genericAdapter;

    if (actor.systemId) {
        const exact = await getAdapter(actor.systemId);
        if (exact && exact.systemId !== 'generic') return exact;
    }

    if (!isInitialized()) initializeRegistry();

    for (const plugin of pluginMap.values()) {
        if (plugin.info.id === 'generic') continue;
        const adapter = await getAdapter(plugin.info.id);
        if (adapter && adapter.match(actor)) return adapter;
    }

    return genericAdapter;
}
