import { ApiError } from '@client/ui/api/http';
import type { AuthenticatedStatusPayload } from '@shared/contracts/status';

const STATUS_RETRY_INITIAL_DELAY_MS = 500;
const STATUS_RETRY_MAX_DELAY_MS = 5_000;

// Only service-unavailable responses represent the expected Core start/reload
// boundary. Authentication and other failures retain their existing handling.
export function isStatusBootstrapUnavailable(error: unknown): error is ApiError {
    return error instanceof ApiError && error.status === 503;
}

export function getStatusBootstrapRetryDelayMs(attempt: number): number {
    return Math.min(
        STATUS_RETRY_INITIAL_DELAY_MS * (2 ** Math.min(attempt, 4)),
        STATUS_RETRY_MAX_DELAY_MS,
    );
}

// Setup and closed are definitive non-session states. Startup/offline may be
// transient, so an unauthenticated response there must preserve restore data.
export function shouldDiscardWorldSession(
    status: Partial<AuthenticatedStatusPayload>,
): boolean {
    const lifecycleStatus = status.system?.status;
    return status.isAuthenticated === false &&
        (lifecycleStatus === 'setup' || lifecycleStatus === 'closed');
}
