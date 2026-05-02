import { logger } from '@shared/utils/logger';
import type { SystemModuleInfo } from '../core/types';

/**
 * Result of a dependency check operation.
 */
export interface DependencyCheckResult {
    canProceed: boolean;
    violations?: DependencyViolation[];
}

/**
 * A specific dependency or conflict violation.
 */
export interface DependencyViolation {
    type: 'missing-dependency' | 'unmet-dependency' | 'conflicting-module' | 'has-dependents';
    moduleId: string;
    affectedModule: string;
    reason: string;
}

/**
 * Check if a module can be enabled based on its dependencies.
 * 
 * @param moduleId - Module to enable
 * @param moduleInfoMap - Map of module ID to SystemModuleInfo
 * @param enabledModules - Set of currently enabled module IDs
 * @returns Result with violations if any
 */
export function checkEnableDependencies(
    moduleId: string,
    moduleInfoMap: Map<string, SystemModuleInfo>,
    enabledModules: Set<string>
): DependencyCheckResult {
    const lowerModuleId = moduleId.toLowerCase();
    const violations: DependencyViolation[] = [];

    const info = moduleInfoMap.get(lowerModuleId);
    if (!info) {
        return {
            canProceed: false,
            violations: [
                {
                    type: 'missing-dependency',
                    moduleId: lowerModuleId,
                    affectedModule: lowerModuleId,
                    reason: `Module ${moduleId} not found in registry`,
                }
            ]
        };
    }

    // Check if all required dependencies are enabled
    if (info.dependencies && info.dependencies.length > 0) {
        for (const depId of info.dependencies) {
            const depIdLower = depId.toLowerCase();
            if (!moduleInfoMap.has(depIdLower)) {
                violations.push({
                    type: 'missing-dependency',
                    moduleId: lowerModuleId,
                    affectedModule: depIdLower,
                    reason: `Required dependency "${depId}" not found in registry`,
                });
            } else if (!enabledModules.has(depIdLower)) {
                violations.push({
                    type: 'unmet-dependency',
                    moduleId: lowerModuleId,
                    affectedModule: depIdLower,
                    reason: `Required dependency "${depId}" is not enabled`,
                });
            }
        }
    }

    // Check if any conflicting modules are enabled
    if (info.conflicts && info.conflicts.length > 0) {
        for (const conflictId of info.conflicts) {
            const conflictIdLower = conflictId.toLowerCase();
            if (enabledModules.has(conflictIdLower)) {
                violations.push({
                    type: 'conflicting-module',
                    moduleId: lowerModuleId,
                    affectedModule: conflictIdLower,
                    reason: `Module "${moduleId}" conflicts with already-enabled "${conflictId}"`,
                });
            }
        }
    }

    return {
        canProceed: violations.length === 0,
        violations: violations.length > 0 ? violations : undefined,
    };
}

/**
 * Check if a module can be disabled without breaking dependents.
 * 
 * @param moduleId - Module to disable
 * @param moduleInfoMap - Map of module ID to SystemModuleInfo
 * @param enabledModules - Set of currently enabled module IDs
 * @returns Result with violations if other modules depend on this one
 */
export function checkDisableDependents(
    moduleId: string,
    moduleInfoMap: Map<string, SystemModuleInfo>,
    enabledModules: Set<string>
): DependencyCheckResult {
    const lowerModuleId = moduleId.toLowerCase();
    const violations: DependencyViolation[] = [];

    // Find all enabled modules that depend on this one
    for (const [otherModuleId, info] of moduleInfoMap.entries()) {
        if (otherModuleId === lowerModuleId) continue;
        if (!enabledModules.has(otherModuleId)) continue;

        if (info.dependencies && info.dependencies.some(d => d.toLowerCase() === lowerModuleId)) {
            violations.push({
                type: 'has-dependents',
                moduleId: lowerModuleId,
                affectedModule: otherModuleId,
                reason: `Module "${info.title}" (${otherModuleId}) requires "${moduleId}" to be enabled`,
            });
        }
    }

    return {
        canProceed: violations.length === 0,
        violations: violations.length > 0 ? violations : undefined,
    };
}

/**
 * Format dependency violations into a human-readable error message.
 */
export function formatDependencyError(violations?: DependencyViolation[]): string {
    if (!violations || violations.length === 0) {
        return 'Dependency constraint violation';
    }

    const lines = violations.map(v => `  • ${v.reason}`);
    return 'Cannot proceed due to dependency constraints:\n' + lines.join('\n');
}
