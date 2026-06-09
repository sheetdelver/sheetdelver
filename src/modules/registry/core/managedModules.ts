/**
 * Managed-module operations — install / upgrade / uninstall / validate plus
 * the corresponding dry-run variants. Heavy logic: source resolution,
 * artifact verification, trust-policy evaluation, dependency / conflict
 * impact analysis, and lifecycle store mutation.
 *
 * Per ADR-0022 Phase 3, this was carved out of `server.ts`. State lives in
 * `./state`; cross-cutting private helpers in `./internals`; ensure-discovery
 * imports registry scanning from `./bootstrap`.
 */
import path from 'node:path';
import fs from 'node:fs';
import { logger } from '@shared/utils/logger';
import {
    ModuleSourceCategory,
    ModuleSourceKind,
    ModuleLifecycleStatus,
    ManagerOutcome,
    ManagerAction,
    ArtifactVerificationStatus,
    ModuleTrustTier,
} from '@shared/types/modules';
import { type SystemModuleInfo, type SystemPlugin } from './types';
import { getModulesDataDir } from '@/server/core/paths';
import {
    applyLifecycleClassification,
    ModuleLifecycleClassificationInput,
    saveLifecycleStore,
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
} from './manager';
import { getArtifact, loadArtifactStore, saveArtifactStore, upsertArtifactVerification } from '../distribution/artifactStore';
import {
    evaluateTrustPolicy,
    type TrustPolicyDecision,
} from '../security/trustPolicy';
import { verifyArtifactMetadata, type ArtifactVerificationOutcome } from '../security/artifactVerification';
import { evaluatePermissionDelta, type PermissionDeltaResult } from '../security/permissionPolicy';
import type { ModuleSourceResolution } from '../distribution/sourceAdapters';
import {
    pluginMap,
    lifecycleStore,
    isInitialized,
} from './state';
import {
    getLifecycleRecord,
    isManifestFailOpenEnabled,
    getTrustPolicyConfig,
    getLifecycleStateFilePathOverride,
    getArtifactStateFilePathOverride,
    getCoreVersion,
    resolveManagedSource,
} from './internals';
import { initializeRegistry, refreshRegistry } from './bootstrap';

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
            status: ModuleLifecycleStatus.Incompatible,
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
            status: ModuleLifecycleStatus.Errored,
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
            trust: resolvedSource.trustTier ? { tier: resolvedSource.trustTier } : { tier: (resolvedSource.kind === ModuleSourceKind.Local || resolvedSource.kind === ModuleSourceKind.Indexed) ? ModuleTrustTier.Unverified : ModuleTrustTier.Untrusted },
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
    operation: typeof ManagerAction.Install | typeof ManagerAction.Upgrade,
    source: string,
    reason: string
): ArtifactVerificationOutcome {
    return {
        moduleId,
        operation,
        status: ArtifactVerificationStatus.Failed,
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
        outcome: blockingReasons.length === 0 ? ManagerOutcome.Allow : ManagerOutcome.Block,
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

    // Block install over manually placed modules that are not lifecycle-managed.
    // Local-dev modules (source === ModuleSourceCategory.Local) are superseded by managed installs.
    if (plugin && !existingArtifact && plugin.source !== ModuleSourceCategory.Local) {
        return operationFailure(
            id,
            'install',
            'Cannot install over an unmanaged module. Management operations are disabled for local system modules.',
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
            applyLifecycleClassification(lifecycleStore, id, ModuleSourceCategory.Managed, gate.classification);
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
            'Cannot upgrade an unmanaged module. Management operations are disabled for local system modules.',
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
            applyLifecycleClassification(lifecycleStore, id, ModuleSourceCategory.Managed, gate.classification);
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
            'Cannot uninstall an unmanaged module. These modules must be removed manually from the filesystem.',
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

export function validateManagedModule(moduleId: string, source?: ModuleSourceCategory): ManagerOperationResult {
    if (!isInitialized()) initializeRegistry();

    const id = moduleId.toLowerCase();
    const record = getLifecycleRecord(id);
    if (!record) {
        return operationFailure(id, 'validate', 'Module record not found in lifecycle store', undefined, 'module-not-found');
    }

    const targetSource = source || record.activeSource || ModuleSourceCategory.Managed;
    
    // Clear health immediately
    if (record.sourceStates && record.sourceStates[targetSource]) {
        record.sourceStates[targetSource]!.health = undefined;
    }
    if (targetSource === record.activeSource) {
        record.health = undefined;
    }

    saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
    
    // Force a registry refresh which will automatically re-evaluate all sources,
    // picking up the cleared health and checking the manifest.
    refreshRegistry();

    const updatedRecord = getLifecycleRecord(id);
    const sourceState = updatedRecord?.sourceStates?.[targetSource] || updatedRecord;

    if (!sourceState || sourceState.status === 'errored' || sourceState.status === 'incompatible') {
        return operationFailure(
            id,
            'validate',
            sourceState?.reason || 'Module validation failed',
            sourceState?.status,
            'validation-failed'
        );
    }

    return operationSuccess(id, 'validate', record.status, sourceState.status);
}
