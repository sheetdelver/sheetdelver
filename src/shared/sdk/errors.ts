/**
 * Structured SDK error taxonomy (ADR-0027 decision 24).
 *
 * Completes the platform's `{ error, status }` wire convention with a stable,
 * machine-readable `code` modules can switch on. `out_of_scope` is the fail-closed
 * signal (declared-scope / unknown reads); `not_ready` is the readiness signal.
 */
export type SdkErrorCode =
    | 'not_found'
    | 'permission_denied'
    | 'out_of_scope'
    | 'not_ready'
    | 'validation'
    | 'conflict'
    | 'internal';

/** Default HTTP status per code, used when a caller does not override it. */
export const SDK_ERROR_STATUS: Record<SdkErrorCode, number> = {
    not_found: 404,
    permission_denied: 403,
    out_of_scope: 403,
    not_ready: 503,
    validation: 400,
    conflict: 409,
    internal: 500,
};

/**
 * SdkError carries a stable `code` and an HTTP `status`. Thrown by server services
 * and emitted by the `error()` route helper; modules may `instanceof`-check it.
 */
export class SdkError extends Error {
    readonly code: SdkErrorCode;
    readonly status: number;

    constructor(code: SdkErrorCode, message: string, status?: number) {
        super(message);
        this.name = 'SdkError';
        this.code = code;
        this.status = status ?? SDK_ERROR_STATUS[code];
    }
}

/** Narrow an unknown thrown value to an SdkError. */
export function isSdkError(value: unknown): value is SdkError {
    return value instanceof SdkError;
}
