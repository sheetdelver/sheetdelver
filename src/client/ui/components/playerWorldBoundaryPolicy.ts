import type { ConnectionStep } from '@shared/interfaces';

export interface PlayerBoundaryInput {
    step: ConnectionStep;
    linkState: 'connecting' | 'checking' | 'ready' | 'guest' | 'disconnected' | 'unavailable';
    hasSessionMarker: boolean;
    currentScope: string | null;
    mountedScope: string | null;
}

/** Presentation only: authorization remains on protected HTTP and socket paths. */
export function decidePlayerBoundary(input: PlayerBoundaryInput) {
    const terminal = input.step === 'setup' || input.step === 'world-closed'
        || input.step === 'login' || input.step === 'logging-out';
    const ready = input.step === 'dashboard' && input.linkState === 'ready'
        && input.hasSessionMarker && !!input.currentScope;
    // Core may confirm the browser socket before the next status broadcast
    // advances an intermediate step (notably `authenticating`) to dashboard.
    // That gap is still transitional, not a reason to unmount a prior page.
    const transient = !terminal && !ready;
    const sameScope = !!input.mountedScope && (!input.currentScope || input.currentScope === input.mountedScope);
    const retainPage = !!input.mountedScope && sameScope && (ready || transient);
    return { terminal, ready, retainPage, blocked: retainPage && !ready };
}
