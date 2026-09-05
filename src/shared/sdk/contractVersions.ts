// Canonical SDK and API contract versions. The public SDK re-exports these
// values, while lifecycle validation consumes them directly to prevent drift.
export const SDK_VERSION = '1.1.0';

export const API_CONTRACT_VERSIONS = {
    'module-api': '1.0.0',
    'ui-extension-api': '1.1.0',
    'roll-engine-api': '1.0.0',
} as const;
