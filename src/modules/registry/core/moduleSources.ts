/**
 * Module-source operations: switch between local-dev / managed installs,
 * enable / disable per source, and expose the per-module active source map
 * used by client routing.
 *
 * Per ADR-0022 Phase 3, this was carved out of `server.ts`. State lives in
 * `./state`; cross-cutting private helpers in `./internals`. `unloadSystemModules`
 * comes from `./adapterResolution`. `refreshRegistry` and the initial
 * `initializeRegistry` ensure-discovery call come from `./server`.
 */
import path from 'node:path';
import fs from 'node:fs';
import { logger } from '@shared/utils/logger';
import { ModuleSourceCategory } from '@shared/types/modules';
import { saveLifecycleStore } from '../lifecycle/lifecycle';
import { getModulesDataDir } from '@/server/core/paths';
import { pluginMap, lifecycleStore, isInitialized } from './state';
import { getLifecycleRecord, getLifecycleStateFilePathOverride } from './internals';
import { unloadSystemModules } from './adapterResolution';
import { initializeRegistry, refreshRegistry } from './server';

/**
 * Switches a module between its local dev version and managed install.
 * Only valid when both localDirectory and a managed directory exist.
 * Evicts the adapter cache and re-runs the registry scan so the new source takes effect immediately.
 */
export function switchModuleSource(moduleId: string, source: ModuleSourceCategory): { success: boolean; error?: string } {
    if (!isInitialized()) initializeRegistry();
    const id = moduleId.toLowerCase();
    const record = getLifecycleRecord(id);
    if (!record) return { success: false, error: 'Module not found' };

    // Persist the current enabled state for the source we're leaving
    if (record.activeSource === ModuleSourceCategory.Local) {
        record.localEnabled = record.enabled;
    } else {
        record.managedEnabled = record.enabled;
    }

    if (source === ModuleSourceCategory.Local) {
        if (!record.localDirectory) return { success: false, error: 'No local dev version available for this module' };
        record.directory    = record.localDirectory;
        record.activeSource = ModuleSourceCategory.Local;
        // Restore the saved enabled state for local, defaulting to true on first switch
        record.enabled = record.localEnabled ?? true;
    } else {
        const managedDir = path.join(getModulesDataDir(), id);
        if (!fs.existsSync(managedDir)) return { success: false, error: 'No managed install found for this module' };
        record.directory    = managedDir;
        record.activeSource = ModuleSourceCategory.Managed;
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
export function disableModule(moduleId: string, reason = 'Module disabled by operator', source?: ModuleSourceCategory): boolean {
    if (!isInitialized()) initializeRegistry();
    const id = moduleId.toLowerCase();

    const record = getLifecycleRecord(id);
    if (!record) return false;

    const targetSource = source ?? record.activeSource;

    if (targetSource !== record.activeSource) {
        // Targeting the dormant source — just update its persisted flag.
        if (targetSource === ModuleSourceCategory.Local) record.localEnabled   = false;
        else                          record.managedEnabled = false;
        record.updatedAt = Date.now();
        saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
        return true;
    }

    record.enabled = false;
    record.status  = 'disabled';
    record.reason  = reason;
    record.updatedAt = Date.now();

    if (record.activeSource === ModuleSourceCategory.Local) record.localEnabled   = false;
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
export function enableModule(moduleId: string, source?: ModuleSourceCategory): boolean {
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

    if (record.activeSource === ModuleSourceCategory.Local) record.localEnabled   = true;
    else                                 record.managedEnabled = true;

    saveLifecycleStore(lifecycleStore, getLifecycleStateFilePathOverride());
    return true;
}

/**
 * Returns a map of moduleId → activeSource for all discovered modules.
 * ModuleSourceCategory.Local means the dev source in data/local/modules is active;
 * ModuleSourceCategory.Managed means the managed install in data/modules is active;
 * ModuleSourceCategory.BuiltIn means the module lives in <DATA_DIR>/modules.
 * Used by the client's getUIModule to pick the correct import alias.
 */
export function getModuleActiveSources(): Record<string, ModuleSourceCategory> {
    const result: Record<string, ModuleSourceCategory> = {};
    for (const [id, plugin] of pluginMap.entries()) {
        const record = lifecycleStore.modules[id];
        const activeSource = record?.activeSource ?? plugin.source;
        if (activeSource === ModuleSourceCategory.Local || activeSource === ModuleSourceCategory.Managed || activeSource === ModuleSourceCategory.BuiltIn) {
            result[id] = activeSource;
        }
    }
    return result;
}
