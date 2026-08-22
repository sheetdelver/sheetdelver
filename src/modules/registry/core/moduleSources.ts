/**
 * Module-source operations: switch between local-dev / managed installs,
 * enable / disable per source, and expose the per-module active source map
 * used by client routing.
 *
 * Per ADR-0022 Phase 3, this was carved out of `server.ts`. State lives in
 * `./state`; cross-cutting private helpers in `./internals`. `unloadSystemModules`
 * comes from `./adapterResolution`. Registry scanning comes from `./bootstrap`.
 */
import path from 'node:path';
import { parseModuleId } from '@shared/security/moduleId';
import fs from 'node:fs';
import { logger } from '@shared/utils/logger';
import { ModuleLifecycleStatus, ModuleSourceCategory } from '@shared/types/modules';
import { saveLifecycleStore, type ModuleLifecycleRecord, type ModuleLifecycleValidation } from '../lifecycle/lifecycle';
import { getModulesDataDir } from '@/server/core/paths';
import { pluginMap, lifecycleStore, isInitialized } from './state';
import { getLifecycleRecord, getLifecycleStateFilePathOverride } from './internals';
import { unloadSystemModules } from './adapterResolution';
import { initializeRegistry, refreshRegistry } from './bootstrap';

/** A validation failure that must block selecting or enabling a source. */
interface SourceBlock {
    status: typeof ModuleLifecycleStatus.Errored | typeof ModuleLifecycleStatus.Incompatible;
    reason: string;
}

function getValidationBlock(validation?: ModuleLifecycleValidation): SourceBlock | undefined {
    if (!validation) return undefined;

    // Invalid manifests and declared incompatibility are already hard blockers.
    if (!validation.manifestValid) {
        return {
            status: ModuleLifecycleStatus.Errored,
            reason: validation.validationErrors?.[0] || 'Cannot enable invalid module manifest',
        };
    }

    if (!validation.compatible) {
        const diagnostic = validation.coreDiagnostics?.find(entry => !entry.compatible)
            || validation.contractDiagnostics?.find(entry => !entry.compatible);
        return {
            status: ModuleLifecycleStatus.Incompatible,
            reason: diagnostic?.reason || 'Cannot enable incompatible module',
        };
    }

    // Artifact warnings are intentionally ignored here. Only an artifact diagnostic
    // marked error means the installed source is too broken to select or enable.
    const artifactError = validation.artifactDiagnostics?.find(diagnostic => diagnostic.severity === 'error');
    if (artifactError) {
        return {
            status: ModuleLifecycleStatus.Errored,
            reason: artifactError.message,
        };
    }

    return undefined;
}

function getSourceBlock(record: ModuleLifecycleRecord, source: ModuleSourceCategory | undefined): SourceBlock | undefined {
    // Prefer source-specific validation so enabling the dormant managed/local card
    // uses that source's own artifact and compatibility diagnostics.
    const sourceState = source ? record.sourceStates?.[source] : undefined;
    const validation = sourceState?.validation ?? (source === record.activeSource || !source ? record.validation : undefined);
    return getValidationBlock(validation);
}

function updateSourceState(
    record: ModuleLifecycleRecord,
    source: ModuleSourceCategory | undefined,
    patch: { status: ModuleLifecycleRecord['status']; enabled: boolean; reason?: string }
): void {
    if (!source) return;
    // The admin UI reads split-card state directly from sourceStates. Keep it in
    // sync when an operator enables/disables without waiting for another scan.
    const existingSourceState = record.sourceStates?.[source];
    const baseSourceState = existingSourceState ?? {
        status: patch.status,
        enabled: patch.enabled,
    };
    record.sourceStates = {
        ...record.sourceStates,
        [source]: {
            ...baseSourceState,
            ...patch,
        },
    };
}

function markActiveSourceBlocked(record: ModuleLifecycleRecord, block: SourceBlock): void {
    // A failed enable of the active source should leave both the top-level record
    // and its source card in the same blocked state.
    record.enabled = false;
    record.status = block.status;
    record.reason = block.reason;
    record.updatedAt = Date.now();

    if (record.activeSource === ModuleSourceCategory.Local) record.localEnabled = false;
    else if (record.activeSource === ModuleSourceCategory.Managed) record.managedEnabled = false;

    updateSourceState(record, record.activeSource, {
        status: block.status,
        enabled: false,
        reason: block.reason,
    });
}

/**
 * Switches a module between its local dev version and managed install.
 * Only valid when both localDirectory and a managed directory exist.
 * Evicts the adapter cache and re-runs the registry scan so the new source takes effect immediately.
 */
export function switchModuleSource(moduleId: string, source: ModuleSourceCategory): { success: boolean; error?: string } {
    if (!isInitialized()) initializeRegistry();
    const id = parseModuleId(moduleId);
    if (!id) return { success: false, error: 'Invalid module ID' };
    const record = getLifecycleRecord(id);
    if (!record) return { success: false, error: 'Module not found' };

    if (source === ModuleSourceCategory.Local && !record.localDirectory) {
        return { success: false, error: 'No local dev version available for this module' };
    }
    if (source === ModuleSourceCategory.Managed) {
        const managedDir = path.join(getModulesDataDir(), id);
        if (!fs.existsSync(managedDir)) return { success: false, error: 'No managed install found for this module' };
    }

    const targetBlock = getSourceBlock(record, source);
    if (targetBlock) {
        // Reject the switch before mutating activeSource so a broken installed
        // package cannot become the runtime-selected implementation.
        logger.warn(`Registry | Refusing to switch module "${id}" to ${source}: ${targetBlock.reason}`);
        return { success: false, error: targetBlock.reason };
    }

    // Persist the current enabled state for the source we're leaving
    if (record.activeSource === ModuleSourceCategory.Local) {
        record.localEnabled = record.enabled;
    } else {
        record.managedEnabled = record.enabled;
    }

    if (source === ModuleSourceCategory.Local) {
        const localDirectory = record.localDirectory;
        if (!localDirectory) return { success: false, error: 'No local dev version available for this module' };
        record.directory    = localDirectory;
        record.activeSource = ModuleSourceCategory.Local;
        // Restore the saved enabled state for local, defaulting to true on first switch
        record.enabled = record.localEnabled ?? true;
    } else {
        const managedDir = path.join(getModulesDataDir(), id);
        record.directory    = managedDir;
        record.activeSource = ModuleSourceCategory.Managed;
        // Restore the saved enabled state for managed, defaulting to true on first switch
        record.enabled = record.managedEnabled ?? true;
    }

    record.status    = record.enabled ? 'validated' : 'disabled';
    record.reason    = record.enabled ? undefined : 'Module disabled in persisted lifecycle state';
    record.updatedAt = Date.now();
    updateSourceState(record, record.activeSource, {
        status: record.status,
        enabled: record.enabled,
        reason: record.reason,
    });
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
export function disableModule(moduleId: string, reason = 'Module disabled by operator', source?: ModuleSourceCategory): boolean {
    if (!isInitialized()) initializeRegistry();
    const id = parseModuleId(moduleId);
    if (!id) return false;

    const record = getLifecycleRecord(id);
    if (!record) return false;

    const targetSource = source ?? record.activeSource;

    if (targetSource !== record.activeSource) {
        // Targeting the dormant source — just update its persisted flag.
        if (targetSource === ModuleSourceCategory.Local) record.localEnabled   = false;
        else                          record.managedEnabled = false;
        record.updatedAt = Date.now();
        updateSourceState(record, targetSource, {
            status: ModuleLifecycleStatus.Disabled,
            enabled: false,
            reason,
        });
        saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
        return true;
    }

    record.enabled = false;
    record.status  = 'disabled';
    record.reason  = reason;
    record.updatedAt = Date.now();

    if (record.activeSource === ModuleSourceCategory.Local) record.localEnabled   = false;
    else                                 record.managedEnabled = false;
    updateSourceState(record, record.activeSource, {
        status: record.status,
        enabled: false,
        reason,
    });

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
export function enableModule(moduleId: string, source?: ModuleSourceCategory): boolean {
    if (!isInitialized()) initializeRegistry();
    const id = parseModuleId(moduleId);
    if (!id) return false;
    const record = getLifecycleRecord(id);
    if (!record) return false;

    // If the operator is targeting a source that isn't currently active, switch
    // to it first. switchModuleSource handles the per-source state bookkeeping.
    if (source && source !== record.activeSource) {
        const switchResult = switchModuleSource(id, source);
        if (!switchResult.success) return false;
    }

    const block = getSourceBlock(record, record.activeSource);
    if (block) {
        // Enabling is the enforcement boundary for artifact errors. Warning-only
        // diagnostics have already been recorded in lifecycle state and are allowed.
        markActiveSourceBlocked(record, block);
        saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
        return false;
    }

    record.enabled = true;
    record.status  = 'validated';
    record.reason  = undefined;
    record.updatedAt = Date.now();

    if (record.activeSource === ModuleSourceCategory.Local) record.localEnabled   = true;
    else                                 record.managedEnabled = true;
    updateSourceState(record, record.activeSource, {
        status: record.status,
        enabled: true,
        reason: undefined,
    });

    saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
    return true;
}

/**
 * Returns a map of moduleId → activeSource for all discovered modules.
 * ModuleSourceCategory.Local means the dev source in <DATA_DIR>/local/modules is active;
 * ModuleSourceCategory.Managed means the managed install in <DATA_DIR>/modules is active.
 * Used by the client's getUIModule to choose local bundled source or runtime ESM.
 */
export function getModuleActiveSources(): Record<string, ModuleSourceCategory> {
    const result: Record<string, ModuleSourceCategory> = {};
    for (const [id, plugin] of pluginMap.entries()) {
        const record = lifecycleStore.modules[id];
        const activeSource = record?.activeSource ?? plugin.source;
        if (activeSource === ModuleSourceCategory.Local || activeSource === ModuleSourceCategory.Managed) {
            result[id] = activeSource;
        }
    }
    return result;
}
