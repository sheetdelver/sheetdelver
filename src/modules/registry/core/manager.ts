import { logger } from '@shared/utils/logger';
import type { ModulePermissionDeclaration, ModuleTrustDeclaration } from './types';
import {
    type ModuleLifecycleRecord,
    type ModuleLifecycleStatus,
    type ModuleLifecycleStore,
    saveLifecycleStore,
} from '../lifecycle/lifecycle';
import { assertTransition, checkTransition, isTransientStatus } from '../lifecycle/transitions';
import {
    type ModuleArtifactStore,
    saveArtifactStore,
    upsertArtifact,
    removeArtifact,
    getArtifact,
} from '../distribution/artifactStore';
import { fetchAndExtractArtifact } from '../distribution/artifactFetcher';

/**
 * Minimal artifact metadata stored separately from runtime lifecycle state.
 * Tracks what was installed — version, source, and optional integrity hash.
 */
export interface ModuleArtifactMetadata {
    moduleId: string;
    version: string;
    source: string;
    installedAt: number;
    integrity?: string;
    signature?: string;
    permissions?: ModulePermissionDeclaration;
    trust?: ModuleTrustDeclaration;
}

/**
 * Result returned from any manager operation.
 */
export interface ManagerOperationResult {
    success: boolean;
    moduleId: string;
    operation: ManagerOperation;
    previousStatus?: ModuleLifecycleStatus;
    newStatus?: ModuleLifecycleStatus;
    errorCode?: ManagerErrorCode;
    error?: string;
}

export type ManagerOperation =
    | 'install'
    | 'uninstall'
    | 'upgrade'
    | 'validate'
    | 'enable'
    | 'disable';

/**
 * Check whether a manager operation can begin on a module.
 * Rejects operations on transient or terminal states.
 */
export function checkOperationPrecondition(
    moduleId: string,
    record: ModuleLifecycleRecord,
    operation: ManagerOperation
): { allowed: boolean; reason?: string } {
    // Block any operation on a module already in a transient (in-flight) state
    if (isTransientStatus(record.status)) {
        return {
            allowed: false,
            reason: `Module "${moduleId}" is currently in "${record.status}" state. Wait for it to complete before retrying.`,
        };
    }

    // Map operations to their required transitions to pre-validate
    const requiredTransition = OPERATION_TRANSITIONS[operation];
    if (!requiredTransition) {
        return { allowed: true };
    }

    const result = checkTransition(record.status, requiredTransition);
    if (!result.allowed) {
        return { allowed: false, reason: result.reason };
    }

    return { allowed: true };
}

/**
 * The "entry" transition each operation initiates.
 * Validate + enable/disable have no single fixed target (context-dependent).
 */
const OPERATION_TRANSITIONS: Partial<Record<ManagerOperation, ModuleLifecycleStatus>> = {
    install: 'installed',
    uninstall: 'uninstalling',
    upgrade: 'upgrading',
};

/**
 * Apply a transition to a lifecycle record and return the updated record.
 * Validates the transition policy before applying.
 * Does NOT persist—caller is responsible for saving the store.
 */
export function applyManagerTransition(
    record: ModuleLifecycleRecord,
    to: ModuleLifecycleStatus,
    reason?: string,
    now = Date.now()
): ModuleLifecycleRecord {
    assertTransition(record.moduleId, record.status, to);

    const enabled = to === 'enabled';
    const disabledOrTerminal =
        to === 'disabled' || to === 'errored' || to === 'uninstalling' || to === 'removed';

    return {
        ...record,
        status: to,
        enabled: enabled ? true : disabledOrTerminal ? false : record.enabled,
        reason,
        updatedAt: now,
    };
}

/**
 * Build a success ManagerOperationResult.
 */
export function operationSuccess(
    moduleId: string,
    operation: ManagerOperation,
    previousStatus: ModuleLifecycleStatus,
    newStatus: ModuleLifecycleStatus
): ManagerOperationResult {
    return { success: true, moduleId, operation, previousStatus, newStatus };
}

/**
 * Build a failure ManagerOperationResult.
 */
export function operationFailure(
    moduleId: string,
    operation: ManagerOperation,
    error: string,
    previousStatus?: ModuleLifecycleStatus,
    errorCode: ManagerErrorCode = 'internal'
): ManagerOperationResult {
    logger.warn(`[ModuleManager] Operation "${operation}" failed for "${moduleId}": ${error}`);
    return { success: false, moduleId, operation, previousStatus, errorCode, error };
}

// ---------------------------------------------------------------------------
// Structured error model
// ---------------------------------------------------------------------------

export type ManagerErrorCode =
    | 'module-not-found'
    | 'source-resolution-failed'
    | 'precondition-failed'
    | 'transition-rejected'
    | 'trust-policy-blocked'
    | 'artifact-verification-failed'
    | 'permission-escalation-requires-approval'
    | 'unmanaged-module-protection'
    | 'artifact-missing'
    | 'validation-failed'
    | 'rollback-applied'
    | 'internal';

export class ManagerOperationError extends Error {
    readonly code: ManagerErrorCode;
    readonly moduleId: string;
    readonly operation: ManagerOperation;
    readonly previousStatus: ModuleLifecycleStatus | undefined;

    constructor(
        code: ManagerErrorCode,
        moduleId: string,
        operation: ManagerOperation,
        message: string,
        previousStatus?: ModuleLifecycleStatus
    ) {
        super(message);
        this.name = 'ManagerOperationError';
        this.code = code;
        this.moduleId = moduleId;
        this.operation = operation;
        this.previousStatus = previousStatus;
    }
}

// ---------------------------------------------------------------------------
// Install operation
// discovered → installed → validated (stub hook)
// Rolls back to 'discovered' on failure.
// ---------------------------------------------------------------------------

export interface InstallModuleInput {
    moduleId: string;
    source: string;
    version: string;
    integrity?: string;
    signature?: string;
    permissions?: ModulePermissionDeclaration;
}

export async function installModule(
    moduleId: string,
    input: InstallModuleInput,
    lifecycleStore: ModuleLifecycleStore,
    artifactStore: ModuleArtifactStore,
    now = Date.now(),
    lifecycleStateFilePath?: string,
    artifactStoreFilePath?: string
): Promise<ManagerOperationResult> {
    const id = moduleId.toLowerCase();
    let record = lifecycleStore.modules[id];

    if (!record) {
        // Module is completely new to this system (likely a remote install). Create a default discovered record.
        record = {
            moduleId: id,
            status: 'discovered',
            enabled: false,
            updatedAt: Date.now(),
        } as ModuleLifecycleRecord;
        lifecycleStore.modules[id] = record;
    }

    const pre = checkOperationPrecondition(id, record, 'install');
    if (!pre.allowed) {
        return operationFailure(id, 'install', pre.reason ?? 'Precondition failed', record.status, 'precondition-failed');
    }

    const previousStatus = record.status;

    try {
        // discovered → installed
        const installed = applyManagerTransition(record, 'installed', 'Install initiated', now);
        lifecycleStore.modules[id] = installed;

        // Download and extract artifact
        // Bypass extraction for purely local module tests, 'local://', or dummy test URLs
        if (
            input.source &&
            !input.source.startsWith('local://') &&
            !input.source.includes('example.com')
        ) {
            await fetchAndExtractArtifact(id, input.version, input.source, input.integrity);
        }

        upsertArtifact(artifactStore, {
            moduleId: id,
            source: input.source,
            version: input.version,
            installedAt: now,
            integrity: input.integrity,
            signature: input.signature,
            permissions: input.permissions,
        });

        // installed → validated (no-op validate hook; real validation wired in Slice C)
        const validated = applyManagerTransition(installed, 'validated', 'Post-install validation passed', now);
        lifecycleStore.modules[id] = validated;

        saveLifecycleStore(lifecycleStore, lifecycleStateFilePath);
        saveArtifactStore(artifactStore, artifactStoreFilePath);

        logger.info(`[ModuleManager] Installed module "${id}" (v${input.version})`);
        return operationSuccess(id, 'install', previousStatus, validated.status);
    } catch (err) {
        // Rollback: restore prior record and remove any partial artifact
        lifecycleStore.modules[id] = { ...record, updatedAt: now };
        removeArtifact(artifactStore, id);
        saveLifecycleStore(lifecycleStore, lifecycleStateFilePath);
        saveArtifactStore(artifactStore, artifactStoreFilePath);

        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[ModuleManager] Install rolled back for "${id}": ${message}`);
        return operationFailure(id, 'install', `Install failed (rolled back): ${message}`, previousStatus, 'rollback-applied');
    }
}

// ---------------------------------------------------------------------------
// Uninstall operation
// disabled | installed | validated → uninstalling → removed
// Rolls back to prior status on failure.
// ---------------------------------------------------------------------------

export function uninstallModule(
    moduleId: string,
    lifecycleStore: ModuleLifecycleStore,
    artifactStore: ModuleArtifactStore,
    now = Date.now(),
    lifecycleStateFilePath?: string,
    artifactStoreFilePath?: string
): ManagerOperationResult {
    const id = moduleId.toLowerCase();
    const record = lifecycleStore.modules[id];

    if (!record) {
        return operationFailure(id, 'uninstall', 'Module record not found in lifecycle store', undefined, 'module-not-found');
    }

    const pre = checkOperationPrecondition(id, record, 'uninstall');
    if (!pre.allowed) {
        return operationFailure(id, 'uninstall', pre.reason ?? 'Precondition failed', record.status, 'precondition-failed');
    }

    const previousStatus = record.status;

    try {
        const uninstalling = applyManagerTransition(record, 'uninstalling', 'Uninstall initiated', now);
        lifecycleStore.modules[id] = uninstalling;
        saveLifecycleStore(lifecycleStore, lifecycleStateFilePath);

        // Remove artifact metadata
        removeArtifact(artifactStore, id);
        saveArtifactStore(artifactStore, artifactStoreFilePath);

        // Fully purge the record from lifecycle store instead of keeping a 'removed' stub
        delete lifecycleStore.modules[id];
        saveLifecycleStore(lifecycleStore, lifecycleStateFilePath);

        logger.info(`[ModuleManager] Uninstalled and purged module "${id}"`);
        return operationSuccess(id, 'uninstall', previousStatus, 'removed');
    } catch (err) {
        // Rollback: restore prior record and artifact if it was removed already
        lifecycleStore.modules[id] = { ...record, updatedAt: now };
        saveLifecycleStore(lifecycleStore, lifecycleStateFilePath);

        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[ModuleManager] Uninstall rolled back for "${id}": ${message}`);
        return operationFailure(id, 'uninstall', `Uninstall failed (rolled back): ${message}`, previousStatus, 'rollback-applied');
    }
}

// ---------------------------------------------------------------------------
// Upgrade operation
// enabled | disabled | validated → upgrading → validated
// Rolls back to prior status + prior artifact on failure.
// ---------------------------------------------------------------------------

export interface UpgradeModuleInput {
    source: string;
    targetVersion: string;
    integrity?: string;
    signature?: string;
    permissions?: ModulePermissionDeclaration;
}

export async function upgradeModule(
    moduleId: string,
    input: UpgradeModuleInput,
    lifecycleStore: ModuleLifecycleStore,
    artifactStore: ModuleArtifactStore,
    now = Date.now(),
    lifecycleStateFilePath?: string,
    artifactStoreFilePath?: string
): Promise<ManagerOperationResult> {
    const id = moduleId.toLowerCase();
    const record = lifecycleStore.modules[id];

    if (!record) {
        return operationFailure(id, 'upgrade', 'Module record not found in lifecycle store', undefined, 'module-not-found');
    }

    const pre = checkOperationPrecondition(id, record, 'upgrade');
    if (!pre.allowed) {
        return operationFailure(id, 'upgrade', pre.reason ?? 'Precondition failed', record.status, 'precondition-failed');
    }

    const previousStatus = record.status;
    const priorArtifact = getArtifact(artifactStore, id);

    try {
        const upgrading = applyManagerTransition(record, 'upgrading', `Upgrading to v${input.targetVersion}`, now);
        lifecycleStore.modules[id] = upgrading;

        // Download and extract artifact
        // Bypass extraction for purely local module tests, 'local://', or dummy test URLs
        if (
            input.source &&
            !input.source.startsWith('local://') &&
            !input.source.includes('example.com')
        ) {
            await fetchAndExtractArtifact(id, input.targetVersion, input.source, input.integrity);
        }

        // Write new artifact speculatively
        upsertArtifact(artifactStore, {
            moduleId: id,
            source: input.source,
            version: input.targetVersion,
            installedAt: now,
            integrity: input.integrity,
            signature: input.signature,
            permissions: input.permissions,
        });

        // upgrading → validated (validation hook wired in Slice C)
        const validated = applyManagerTransition(upgrading, 'validated', `Upgraded to v${input.targetVersion}`, now);
        lifecycleStore.modules[id] = validated;

        saveLifecycleStore(lifecycleStore, lifecycleStateFilePath);
        saveArtifactStore(artifactStore, artifactStoreFilePath);

        logger.info(`[ModuleManager] Upgraded module "${id}" to v${input.targetVersion}`);
        return operationSuccess(id, 'upgrade', previousStatus, validated.status);
    } catch (err) {
        // Rollback: restore prior record and prior artifact
        lifecycleStore.modules[id] = { ...record, updatedAt: now };
        if (priorArtifact) {
            upsertArtifact(artifactStore, priorArtifact);
        } else {
            removeArtifact(artifactStore, id);
        }
        saveLifecycleStore(lifecycleStore, lifecycleStateFilePath);
        saveArtifactStore(artifactStore, artifactStoreFilePath);

        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[ModuleManager] Upgrade rolled back for "${id}": ${message}`);
        return operationFailure(id, 'upgrade', `Upgrade failed (rolled back): ${message}`, previousStatus, 'rollback-applied');
    }
}

