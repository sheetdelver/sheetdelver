import type { ModuleLifecycleStatus } from './lifecycle';

/**
 * Explicit allowed lifecycle state transitions.
 *
 * Any transition not listed here is invalid and must be rejected.
 * This is the authoritative policy for manager operations.
 */
const ALLOWED_TRANSITIONS: Record<ModuleLifecycleStatus, ModuleLifecycleStatus[]> = {
    discovered:   ['installed', 'incompatible', 'errored'],
    installed:    ['validated', 'incompatible', 'errored', 'uninstalling'],
    validated:    ['enabled', 'disabled', 'incompatible', 'errored', 'upgrading', 'uninstalling'],
    enabled:      ['disabled', 'errored', 'upgrading'],
    disabled:     ['enabled', 'validated', 'upgrading', 'uninstalling', 'errored'],
    errored:      ['disabled', 'uninstalling'],
    incompatible: ['uninstalling'],
    upgrading:    ['validated', 'errored'],
    uninstalling: ['removed', 'errored'],
    removed:      [],
};

/**
 * Result of a lifecycle transition check.
 */
export interface TransitionCheckResult {
    allowed: boolean;
    from: ModuleLifecycleStatus;
    to: ModuleLifecycleStatus;
    reason?: string;
}

/**
 * Check whether a lifecycle status transition is permitted.
 *
 * @param from - Current status
 * @param to - Desired next status
 * @returns TransitionCheckResult with allowed flag and optional reason
 */
export function checkTransition(
    from: ModuleLifecycleStatus,
    to: ModuleLifecycleStatus
): TransitionCheckResult {
    const allowed = ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;

    return {
        allowed,
        from,
        to,
        reason: allowed
            ? undefined
            : `Transition from "${from}" to "${to}" is not permitted`,
    };
}

/**
 * Assert that a lifecycle transition is allowed.
 * Throws a descriptive error if the transition is rejected.
 *
 * @param moduleId - For error message context
 * @param from - Current status
 * @param to - Desired next status
 */
export function assertTransition(
    moduleId: string,
    from: ModuleLifecycleStatus,
    to: ModuleLifecycleStatus
): void {
    const result = checkTransition(from, to);
    if (!result.allowed) {
        throw new Error(
            `[ModuleManager] Cannot transition module "${moduleId}": ${result.reason}`
        );
    }
}

/**
 * Return all valid next states from a given current status.
 */
export function getAllowedTransitions(from: ModuleLifecycleStatus): ModuleLifecycleStatus[] {
    return [...(ALLOWED_TRANSITIONS[from] ?? [])];
}

/**
 * Check whether a module is in a terminal/immutable state.
 * Terminal states cannot transition further.
 */
export function isTerminalStatus(status: ModuleLifecycleStatus): boolean {
    return ALLOWED_TRANSITIONS[status].length === 0;
}

/**
 * Check whether a module is in a transient/in-progress state.
 * Transient states should block re-entrant operations.
 */
export function isTransientStatus(status: ModuleLifecycleStatus): boolean {
    return status === 'upgrading' || status === 'uninstalling';
}
