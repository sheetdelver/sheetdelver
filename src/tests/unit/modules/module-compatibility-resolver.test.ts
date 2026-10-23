import { strict as assert } from 'node:assert';
import { API_CONTRACT_VERSIONS } from '../../../shared/sdk';
import { resolveModuleCompatibility } from '@modules/registry/compatibilityResolver';

export function run() {
    const fixtureCoreVersion = '1.2.3';
    const providedApiContracts = {
        'module-api': '1.0.0',
        'ui-extension-api': '1.0.0',
        'roll-engine-api': '1.0.0',
    };

    const lifecycleRequirement = { 'ui-extension-api': '>=3.0.0 <4.0.0' };
    const lifecycleCompatibility = (provided: Record<string, string>) => resolveModuleCompatibility({
        coreVersion: fixtureCoreVersion, providedApiContracts: provided,
        requiredApiContracts: lifecycleRequirement,
    });
    assert.equal(lifecycleCompatibility({ ...API_CONTRACT_VERSIONS, 'ui-extension-api': '1.3.0' }).compatible, false);
    assert.equal(lifecycleCompatibility(API_CONTRACT_VERSIONS).compatible, true);
    const settingsCompatibility = (version: string, required = '>=3.5.0 <4.0.0') => resolveModuleCompatibility({
        coreVersion: fixtureCoreVersion, providedApiContracts: { 'ui-extension-api': version },
        requiredApiContracts: { 'ui-extension-api': required },
    });
    assert.equal(settingsCompatibility('3.5.0', '>=3.6.0 <4.0.0').compatible, false, 'page headers must reject hosts without the component');
    assert.equal(settingsCompatibility(API_CONTRACT_VERSIONS['ui-extension-api'], '>=3.6.0 <4.0.0').compatible, true);
    assert.equal(settingsCompatibility('3.4.0').compatible, false, 'essential settings tabs require the new UI contract');
    assert.equal(settingsCompatibility(API_CONTRACT_VERSIONS['ui-extension-api']).compatible, true);
    assert.equal(settingsCompatibility(API_CONTRACT_VERSIONS['ui-extension-api'], '>=3.3.0 <4.0.0').compatible, true, 'optional pilots keep an older entry point');
    const richDetailCompatibility = (version: string) => resolveModuleCompatibility({
        coreVersion: '0.18.0', requiredCoreVersion: '>=0.18.0',
        providedApiContracts: { 'module-api': version },
        requiredApiContracts: { 'module-api': '>=1.4.0 <2.0.0' },
    });
    assert.equal(richDetailCompatibility('1.3.0').compatible, false, 'old hosts cannot promise new stat presentation metadata');
    assert.equal(richDetailCompatibility(API_CONTRACT_VERSIONS['module-api']).compatible, true);
    assert.equal(resolveModuleCompatibility({
        coreVersion: fixtureCoreVersion, providedApiContracts: API_CONTRACT_VERSIONS,
        requiredApiContracts: { 'ui-extension-api': '>=1.0.0 <2.0.0' },
    }).compatible, false, 'older UI modules require migration to the new contract');

    const noRequirements = resolveModuleCompatibility({
        coreVersion: fixtureCoreVersion,
        providedApiContracts,
    });
    assert.equal(noRequirements.compatible, true);

    const coreMismatch = resolveModuleCompatibility({
        coreVersion: fixtureCoreVersion,
        requiredCoreVersion: '>=1.3.0 <2.0.0',
        providedApiContracts,
    });
    assert.equal(coreMismatch.compatible, false);
    assert.equal(coreMismatch.reason?.includes('does not satisfy constraint'), true);
    assert.equal(coreMismatch.coreDiagnostics?.length, 2);

    const contractSortingDeterministic = resolveModuleCompatibility({
        coreVersion: fixtureCoreVersion,
        requiredApiContracts: {
            'zzz-contract': '>=1.0.0',
            'aaa-contract': '>=1.0.0',
            'module-api': '>=1.0.0 <2.0.0',
        },
        providedApiContracts,
    });
    assert.equal(contractSortingDeterministic.compatible, false);
    assert.equal(contractSortingDeterministic.contractDiagnostics?.[0]?.contract, 'aaa-contract');
    assert.equal(contractSortingDeterministic.reason?.includes('"aaa-contract" is not provided by core'), true);

    const invalidContractRange = resolveModuleCompatibility({
        coreVersion: fixtureCoreVersion,
        requiredApiContracts: {
            'module-api': '^1.0.0',
        },
        providedApiContracts,
    });
    assert.equal(invalidContractRange.compatible, false);
    assert.equal(invalidContractRange.reason?.includes('invalid constraint'), true);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        run();
        console.log('module-compatibility-resolver.test.ts passed');
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}
