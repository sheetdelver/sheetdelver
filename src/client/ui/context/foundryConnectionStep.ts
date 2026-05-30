import type { ConnectionStep } from '@shared/interfaces';
import type { SystemStatusPayload } from '@shared/contracts/status';

interface DetermineConnectionStepOptions {
    isConfigured: boolean;
    isAuthenticated: boolean;
}

type ConnectionStatusPayload = Pick<SystemStatusPayload, 'connected' | 'initialized' | 'system'>;

export function determineConnectionStep(
    data: ConnectionStatusPayload,
    currentStep: ConnectionStep,
    { isConfigured, isAuthenticated }: DetermineConnectionStepOptions,
): ConnectionStep {
    const status = data.system?.status || (data.connected ? 'active' : 'offline');

    if (!isConfigured) return 'setup';

    const worldTitle = data.system?.worldTitle;

    if (status === 'closed') return 'world-closed';
    if (status === 'setup') return 'world-closed';
    if (status === 'offline') return worldTitle ? 'startup' : 'initializing';
    if (status === 'startup') return 'startup';

    if (!data.connected || data.initialized === false) {
        return worldTitle ? 'startup' : 'initializing';
    }

    if (currentStep === 'authenticating') {
        return isAuthenticated ? 'dashboard' : 'authenticating';
    }

    if (!worldTitle) return 'startup';

    return isAuthenticated ? 'dashboard' : 'login';
}
