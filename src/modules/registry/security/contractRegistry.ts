import { CoreContractName } from '@shared/types/modules';
import { API_CONTRACT_VERSIONS } from '@shared/sdk/contractVersions';

export type { CoreContractName };

export type CoreContractRegistry = Record<CoreContractName, string>;

const CORE_CONTRACT_REGISTRY: CoreContractRegistry = {
    [CoreContractName.ModuleApi]: API_CONTRACT_VERSIONS['module-api'],
    [CoreContractName.UiExtensionApi]: API_CONTRACT_VERSIONS['ui-extension-api'],
    [CoreContractName.RollEngineApi]: API_CONTRACT_VERSIONS['roll-engine-api'],
};

export function getCoreContractRegistry(): CoreContractRegistry {
    return { ...CORE_CONTRACT_REGISTRY };
}
