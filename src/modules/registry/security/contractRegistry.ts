export type CoreContractName = 'module-api' | 'ui-extension-api' | 'roll-engine-api';

export type CoreContractRegistry = Record<CoreContractName, string>;

const CORE_CONTRACT_REGISTRY: CoreContractRegistry = {
    'module-api': '1.0.0',
    'ui-extension-api': '1.0.0',
    'roll-engine-api': '1.0.0',
};

export function getCoreContractRegistry(): CoreContractRegistry {
    return { ...CORE_CONTRACT_REGISTRY };
}
