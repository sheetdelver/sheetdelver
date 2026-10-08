// Canonical SDK and API contract versions. The public SDK re-exports these
// values, while lifecycle validation consumes them directly to prevent drift.
export const SDK_VERSION = '2.2.0';

export const API_CONTRACT_VERSIONS = {
    'module-api': '1.3.0',
    'ui-extension-api': '2.1.0',
    'roll-engine-api': '1.0.0',
} as const;
