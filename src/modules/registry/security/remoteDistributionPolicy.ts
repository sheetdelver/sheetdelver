/** Stable API code returned when dormant remote module operations are attempted. */
export const REMOTE_MODULE_DISTRIBUTION_ERROR_CODE = 'remote-module-distribution-disabled';

/** Operator-facing reason shared by registry and admin boundaries. */
export const REMOTE_MODULE_DISTRIBUTION_ERROR_MESSAGE =
    'Remote module distribution is not supported by the current operating model';

/**
 * Identifies source references that would require network-backed distribution.
 * This is deliberately not configurable: ADR-0033 requires a future ADR and
 * implementation before any settings value may activate these source kinds.
 */
export function isRemoteModuleSourceRef(sourceRef: string): boolean {
    const normalized = sourceRef.trim().toLowerCase();
    return normalized.startsWith('index://')
        || normalized.startsWith('http://')
        || normalized.startsWith('https://');
}

export interface RemoteModuleDistributionDenial {
    code: typeof REMOTE_MODULE_DISTRIBUTION_ERROR_CODE;
    message: typeof REMOTE_MODULE_DISTRIBUTION_ERROR_MESSAGE;
}

/** Returns a fresh structured denial so call sites cannot mutate shared state. */
export function getRemoteModuleDistributionDenial(): RemoteModuleDistributionDenial {
    return {
        code: REMOTE_MODULE_DISTRIBUTION_ERROR_CODE,
        message: REMOTE_MODULE_DISTRIBUTION_ERROR_MESSAGE,
    };
}
