import fs from 'node:fs';
import path from 'node:path';
import { getLocalModulesDir, getModulesDataDir } from '@core/paths';
import { ModuleTrustTier, type ModuleTrustTier as ModuleTrustTierValue } from '@shared/types/modules';
import { parseModuleId } from '@shared/security/moduleId';
import { resolveModuleDirectory } from '@server/security/modulePath';
import { logger } from '@shared/utils/logger';
import type { ModuleReleaseManifest } from '../distribution/releaseManifest';
import {
    discardPreparedModuleArchive,
    prepareModuleArchive,
    promotePreparedModuleArchive,
    type PreparedModuleArchive,
} from '../distribution/archiveTransaction';
import { getArtifact, loadArtifactStore } from '../distribution/artifactStore';
import { operationFailure, type ManagerErrorCode, type ManagerOperationResult } from './manager';
import {
    dryRunInstallManagedModule,
    dryRunUpgradeManagedModule,
    installManagedModule,
    upgradeManagedModule,
    type DryRunManagedModuleResult,
} from './managedModules';
import {
    getArtifactStateFilePathOverride,
    getCoreVersion,
    getLifecycleRecord,
    getLifecycleStateFilePathOverride,
} from './internals';
import { getDefaultLifecycleStateFilePath } from '../lifecycle/lifecycle';
import { getDefaultArtifactStoreFilePath } from '../distribution/artifactStore';
import { discoverMigrations } from '../migrations/catalog';
import type { UpgradePreview, UpgradeJob } from '@server/services/world/migrations/UpgradeJournal';

export type ModuleArchiveOperation = 'install' | 'upgrade';

export interface LocalModuleArchiveInput {
    planId?: string;
    idempotencyKey?: string;
    backupAcknowledged?: boolean;
    administrator?: string;
    archivePath: string;
    expectedModuleId?: string;
    releaseManifest?: ModuleReleaseManifest;
    sourceTrustTier?: ModuleTrustTierValue;
    approveTrustOverride?: boolean;
    approvePermissionEscalation?: boolean;
    artifactSource?: string;
    sourceProfileId?: string;
    preverifiedArtifact?: boolean;
}

export interface ModuleArchiveSummary {
    moduleId: string;
    title: string;
    version: string;
    archiveSize: number;
    integrity: string;
    entryCount: number;
    fileCount: number;
    extractedBytes: number;
    warnings: string[];
    localSourceCollision: boolean;
    activeSource?: string;
}

export interface DryRunLocalModuleArchiveResult {
    migration?: UpgradePreview;
    success: true;
    operation: 'dry-run-install' | 'dry-run-upgrade';
    wouldProceed: boolean;
    blockingReasons: string[];
    archive?: ModuleArchiveSummary;
    governance?: DryRunManagedModuleResult;
}

interface PreparedOperation {
    prepared: PreparedModuleArchive;
    archive: ModuleArchiveSummary;
    source: string;
    sourceTrustTier: ModuleTrustTierValue;
    blockers: string[];
}

const activeArchiveOperations = new Set<string>();

function buildStableLocalArchiveSource(integrity: string): string {
    return `local://archive/${integrity.slice('sha256:'.length)}`;
}

function summarizeArchive(prepared: PreparedModuleArchive): ModuleArchiveSummary {
    const moduleId = parseModuleId(prepared.info.id)!;
    const localModulesRoot = getLocalModulesDir();
    const localDirectory = localModulesRoot
        ? resolveModuleDirectory(localModulesRoot, moduleId)
        : null;
    return {
        moduleId,
        title: prepared.info.title,
        version: prepared.info.version!,
        archiveSize: prepared.archiveSize,
        integrity: prepared.integrity,
        entryCount: prepared.inspection.entryCount,
        fileCount: prepared.inspection.fileCount,
        extractedBytes: prepared.inspection.extractedBytes,
        warnings: prepared.artifactHealth.diagnostics
            .filter((diagnostic) => diagnostic.severity === 'warning')
            .map((diagnostic) => diagnostic.message),
        localSourceCollision: Boolean(localDirectory),
        activeSource: getLifecycleRecord(moduleId)?.activeSource,
    };
}

async function prepareOperation(
    operation: ModuleArchiveOperation,
    input: LocalModuleArchiveInput,
): Promise<PreparedOperation> {
    const prepared = await prepareModuleArchive({
        archivePath: input.archivePath,
        expectedModuleId: input.expectedModuleId,
        releaseManifest: input.releaseManifest,
        coreVersion: getCoreVersion(),
    });
    const archive = summarizeArchive(prepared);
    const artifactStore = loadArtifactStore(getArtifactStateFilePathOverride());
    const existingArtifact = getArtifact(artifactStore, archive.moduleId);
    const managedTarget = path.join(getModulesDataDir(), archive.moduleId);
    let managedTargetExists = false;
    try { managedTargetExists = fs.lstatSync(managedTarget).isDirectory(); } catch { /* absent */ }
    const blockers: string[] = [];

    if (managedTargetExists !== Boolean(existingArtifact)) {
        const missing = managedTargetExists ? 'artifact record' : 'managed package directory';
        blockers.push(`Managed module "${archive.moduleId}" has an incomplete installation: ${missing} missing; inspect the installation before retrying`);
    } else if (operation === 'install' && managedTargetExists) {
        blockers.push(`Managed module "${archive.moduleId}" is already installed; use upgrade instead`);
    } else if (operation === 'upgrade' && !managedTargetExists) {
        blockers.push(`Managed module "${archive.moduleId}" is not installed; use install instead`);
    }

    return {
        prepared,
        archive,
        source: buildStableLocalArchiveSource(prepared.integrity),
        sourceTrustTier: input.sourceTrustTier || ModuleTrustTier.Unverified,
        blockers,
    };
}

function inferGovernanceErrorCode(preview: DryRunManagedModuleResult): ManagerErrorCode {
    if (!preview.sourceResolution.ok) return preview.sourceResolution.errorCode || 'source-resolution-failed';
    if (preview.trustPolicy && !preview.trustPolicy.allowed) return 'trust-policy-blocked';
    if (!preview.manifestGate.allowed) return preview.manifestGate.errorCode || 'validation-failed';
    if (!preview.artifactVerification.verified) return 'artifact-verification-failed';
    if (preview.blockingReasons.some((reason) => reason.includes(' is locked') || reason.includes(' is pinned to v'))) {
        return 'update-policy-blocked';
    }
    if (preview.blockingReasons.some((reason) => reason.startsWith('Permission escalation requires'))) {
        return 'permission-escalation-requires-approval';
    }
    return 'precondition-failed';
}

async function runGovernancePreview(
    operation: ModuleArchiveOperation,
    input: LocalModuleArchiveInput,
    prepared: PreparedOperation,
): Promise<DryRunManagedModuleResult> {
    const governedInfo = {
        ...prepared.prepared.info,
        trust: { tier: prepared.sourceTrustTier },
    };
    if (operation === 'install') {
        return dryRunInstallManagedModule({
            moduleId: prepared.archive.moduleId,
            source: prepared.source,
            version: prepared.archive.version,
            integrity: prepared.archive.integrity,
            permissions: governedInfo.permissions,
            moduleInfo: governedInfo,
            sourceTrustTier: prepared.sourceTrustTier,
            approveTrustOverride: input.approveTrustOverride,
            artifactSource: input.artifactSource,
            sourceProfileId: input.sourceProfileId,
            preverifiedArtifact: input.preverifiedArtifact,
        });
    }
    return dryRunUpgradeManagedModule({
        moduleId: prepared.archive.moduleId,
        source: prepared.source,
        targetVersion: prepared.archive.version,
        integrity: prepared.archive.integrity,
        permissions: governedInfo.permissions,
        moduleInfo: governedInfo,
        sourceTrustTier: prepared.sourceTrustTier,
        approveTrustOverride: input.approveTrustOverride,
        approvePermissionEscalation: input.approvePermissionEscalation,
        artifactSource: input.artifactSource,
        sourceProfileId: input.sourceProfileId,
        preverifiedArtifact: input.preverifiedArtifact,
    });
}

export async function dryRunLocalModuleArchive(
    operation: ModuleArchiveOperation,
    input: LocalModuleArchiveInput,
): Promise<DryRunLocalModuleArchiveResult> {
    let preparedOperation: PreparedOperation | undefined;
    try {
        preparedOperation = await prepareOperation(operation, input);
        const governance = await runGovernancePreview(operation, input, preparedOperation);
        const blockingReasons = [...preparedOperation.blockers, ...governance.blockingReasons];
        let migration: UpgradePreview | undefined;
        const { assertMigrationReplacement, createHostUpgradeCoordinator } = await import('@server/services/world/migrations/ModuleUpgradeService');
        assertMigrationReplacement(preparedOperation.prepared.moduleDirectory, preparedOperation.prepared.info);
        if (blockingReasons.length === 0 && discoverMigrations(preparedOperation.prepared.moduleDirectory, preparedOperation.prepared.info)) {
            migration = await createHostUpgradeCoordinator().preview({ moduleId: preparedOperation.archive.moduleId,
                version: preparedOperation.archive.version, artifactDigest: preparedOperation.archive.integrity,
                root: preparedOperation.prepared.moduleDirectory, info: preparedOperation.prepared.info });
            blockingReasons.push(...migration.plan.blockers);
        }
        return {
            ...(migration ? { migration } : {}),
            success: true,
            operation: operation === 'install' ? 'dry-run-install' : 'dry-run-upgrade',
            wouldProceed: blockingReasons.length === 0,
            blockingReasons,
            archive: preparedOperation.archive,
            governance,
        };
    } catch (error) {
        return {
            success: true,
            operation: operation === 'install' ? 'dry-run-install' : 'dry-run-upgrade',
            wouldProceed: false,
            blockingReasons: [error instanceof Error ? error.message : String(error)],
        };
    } finally {
        if (preparedOperation) discardPreparedModuleArchive(preparedOperation.prepared);
    }
}

export async function applyLocalModuleArchive(
    operation: ModuleArchiveOperation,
    input: LocalModuleArchiveInput,
): Promise<ManagerOperationResult> {
    const fallbackId = parseModuleId(input.expectedModuleId) || 'invalid';
    let preparedOperation: PreparedOperation;
    try {
        preparedOperation = await prepareOperation(operation, input);
    } catch (error) {
        return operationFailure(
            fallbackId,
            operation,
            error instanceof Error ? error.message : String(error),
            undefined,
            'validation-failed',
        );
    }

    const moduleId = preparedOperation.archive.moduleId;
    if (activeArchiveOperations.has(moduleId)) {
        discardPreparedModuleArchive(preparedOperation.prepared);
        return operationFailure(
            moduleId,
            operation,
            `Another archive operation is already in progress for module "${moduleId}"`,
            undefined,
            'precondition-failed',
        );
    }
    activeArchiveOperations.add(moduleId);
    let promotionAttempted = false;
    try {
        const preview = await runGovernancePreview(operation, input, preparedOperation);
        const blockingReasons = [...preparedOperation.blockers, ...preview.blockingReasons];
        if (blockingReasons.length > 0) {
            return operationFailure(
                moduleId,
                operation,
                blockingReasons.join(' | '),
                undefined,
                preparedOperation.blockers.length > 0 ? 'precondition-failed' : inferGovernanceErrorCode(preview),
            );
        }

        const { assertMigrationReplacement, createHostUpgradeCoordinator, getUpgradeJournal } = await import('@server/services/world/migrations/ModuleUpgradeService');
        assertMigrationReplacement(preparedOperation.prepared.moduleDirectory, preparedOperation.prepared.info);
        if (discoverMigrations(preparedOperation.prepared.moduleDirectory, preparedOperation.prepared.info)) {
            if (preparedOperation.archive.activeSource === 'local') throw new Error('Candidate managed package is inactive beside a local source; select the managed source explicitly before its world upgrade');
            if (!input.planId || !input.idempotencyKey || !input.administrator) throw new Error('Admin-reviewed migration plan required before file promotion');
            const coordinator = createHostUpgradeCoordinator({
                promote: async (job: UpgradeJob) => {
                    promotionAttempted = true;
                    job.transactionDirectory = preparedOperation.prepared.transactionDirectory;
                    job.registryBackups = [getLifecycleStateFilePathOverride() ?? getDefaultLifecycleStateFilePath(),
                        getArtifactStateFilePathOverride() ?? getDefaultArtifactStoreFilePath()].map(file => ({ path: file,
                        contents: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null }));
                    getUpgradeJournal().save(job);
                    promotePreparedModuleArchive(preparedOperation.prepared, getModulesDataDir(), (phase, paths) => {
                        job.fileTransition = phase;
                        job.targetDirectory = paths.targetDirectory;
                        job.previousDirectory = paths.previousDirectory;
                        getUpgradeJournal().save(job);
                    });
                    const result = await registerArchive(operation, input, preparedOperation);
                    if (!result.success) throw new Error(result.error || 'Candidate registry transition failed');
                    job.fileTransition = 'registered';
                    job.candidateRoot = job.targetDirectory!;
                    getUpgradeJournal().save(job);
                    // Previous files remain durable. Only successful verified activation
                    // may finalize them; never call the old promotion.commit() here.
                },
                restart: () => { /* HTTP caller schedules the existing supervised restart after flushing 202. */ },
            });
            const job = await coordinator.approve({ moduleId, version: preparedOperation.archive.version,
                artifactDigest: preparedOperation.archive.integrity, root: preparedOperation.prepared.moduleDirectory,
                info: preparedOperation.prepared.info }, { planId: input.planId, idempotencyKey: input.idempotencyKey,
                administrator: input.administrator, backupAcknowledged: input.backupAcknowledged === true });
            return { success: true, moduleId, operation, jobId: job.jobId, accepted: true, restartRequired: job.phase === 'restarting' };
        }

        promotionAttempted = true;
        const promotion = promotePreparedModuleArchive(preparedOperation.prepared);
        const governedInfo = {
            ...preparedOperation.prepared.info,
            trust: { tier: preparedOperation.sourceTrustTier },
        };
        try {
            const result = operation === 'install'
                ? await installManagedModule({
                    moduleId,
                    source: preparedOperation.source,
                    version: preparedOperation.archive.version,
                    integrity: preparedOperation.archive.integrity,
                    permissions: governedInfo.permissions,
                    moduleInfo: governedInfo,
                    sourceTrustTier: preparedOperation.sourceTrustTier,
                    approveTrustOverride: input.approveTrustOverride,
                    artifactSource: input.artifactSource,
                    sourceProfileId: input.sourceProfileId,
                    preverifiedArtifact: input.preverifiedArtifact,
                })
                : await upgradeManagedModule({
                    moduleId,
                    source: preparedOperation.source,
                    targetVersion: preparedOperation.archive.version,
                    integrity: preparedOperation.archive.integrity,
                    permissions: governedInfo.permissions,
                    moduleInfo: governedInfo,
                    sourceTrustTier: preparedOperation.sourceTrustTier,
                    approveTrustOverride: input.approveTrustOverride,
                    approvePermissionEscalation: input.approvePermissionEscalation,
                    artifactSource: input.artifactSource,
                    sourceProfileId: input.sourceProfileId,
                    preverifiedArtifact: input.preverifiedArtifact,
                });
            if (!result.success) {
                promotion.rollback();
                return result;
            }
            try {
                promotion.commit();
            } catch (error) {
                logger.warn(
                    `[ModuleManager] Module "${moduleId}" was applied but transaction cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
            return result;
        } catch (error) {
            promotion.rollback();
            throw error;
        }
    } catch (error) {
        return operationFailure(
            moduleId,
            operation,
            `Archive transaction failed; inspect the retained upgrade/recovery state: ${error instanceof Error ? error.message : String(error)}`,
            undefined,
            'rollback-applied',
        );
    } finally {
        activeArchiveOperations.delete(moduleId);
        if (!promotionAttempted && fs.existsSync(preparedOperation.prepared.transactionDirectory)) {
            discardPreparedModuleArchive(preparedOperation.prepared);
        }
    }
}

async function registerArchive(operation: ModuleArchiveOperation, input: LocalModuleArchiveInput, prepared: PreparedOperation): Promise<ManagerOperationResult> {
    const common = {
        moduleId: prepared.archive.moduleId, source: prepared.source, integrity: prepared.archive.integrity,
        permissions: prepared.prepared.info.permissions, moduleInfo: { ...prepared.prepared.info, trust: { tier: prepared.sourceTrustTier } },
        sourceTrustTier: prepared.sourceTrustTier, approveTrustOverride: input.approveTrustOverride,
        approvePermissionEscalation: input.approvePermissionEscalation, artifactSource: input.artifactSource,
        sourceProfileId: input.sourceProfileId, preverifiedArtifact: input.preverifiedArtifact,
    };
    return operation === 'install' ? installManagedModule({ ...common, version: prepared.archive.version })
        : upgradeManagedModule({ ...common, targetVersion: prepared.archive.version });
}
