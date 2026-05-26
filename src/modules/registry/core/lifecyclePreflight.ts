/**
 * Lifecycle preflight checks — answer the "can I enable/disable this module
 * right now without breaking dependencies or conflicts?" question without
 * mutating state. Used by the admin UI to gate the corresponding actions.
 *
 * Per ADR-0022 Phase 3, this was carved out of `server.ts`.
 */
import { pluginMap, lifecycleStore, isInitialized } from './state';
import { initializeRegistry } from './server';

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
