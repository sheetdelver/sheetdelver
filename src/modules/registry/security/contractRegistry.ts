import { CoreContractName } from '@shared/types/modules';

export type { CoreContractName };

export type CoreContractRegistry = Record<CoreContractName, string>;

const CORE_CONTRACT_REGISTRY: CoreContractRegistry = {
    [CoreContractName.ModuleApi]: '1.0.0',
    [CoreContractName.UiExtensionApi]: '1.0.0',
    [CoreContractName.RollEngineApi]: '1.0.0',
};

export function getCoreContractRegistry(): CoreContractRegistry {
    return { ...CORE_CONTRACT_REGISTRY };
}
