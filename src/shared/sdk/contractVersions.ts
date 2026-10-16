// Canonical SDK and API contract versions. The public SDK re-exports these
// values, while lifecycle validation consumes them directly to prevent drift.
export const SDK_VERSION = '3.3.0';
/** Stable introduction floor, not the host's changing provided API version. */
export const WORLD_MIGRATION_API_MINIMUM = '1.5.0';

export const API_CONTRACT_VERSIONS = {
    'module-api': '1.5.0',
    'ui-extension-api': '3.2.0',
    'roll-engine-api': '1.0.0',
} as const;
