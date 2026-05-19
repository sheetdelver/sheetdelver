import { strict as assert } from 'node:assert';
import { resolveModuleCompatibility } from '@modules/registry/compatibilityResolver';

interface MatrixCase {
    name: string;
    coreVersion: string;
    requiredCoreVersion?: string;
    requiredApiContracts?: Record<string, string>;
    providedApiContracts: Record<string, string>;
    expectedCompatible: boolean;
    expectedReasonIncludes?: string;
}

export function run() {
    const providedApiContracts = {
        'module-api': '1.0.0',
        'ui-extension-api': '1.0.0',
        'roll-engine-api': '1.0.0',
    };

    const matrix: MatrixCase[] = [
        {
            name: 'core and contracts both compatible',
            coreVersion: '0.7.0',
            requiredCoreVersion: '>=0.7.0 <1.0.0',
            requiredApiContracts: {
                'module-api': '>=1.0.0 <2.0.0',
                'ui-extension-api': '=1.0.0',
            },
            providedApiContracts,
            expectedCompatible: true,
        },
        {
            name: 'core constraint mismatch',
            coreVersion: '0.7.0',
            requiredCoreVersion: '>=0.8.0 <1.0.0',
            providedApiContracts,
            expectedCompatible: false,
            expectedReasonIncludes: 'does not satisfy constraint',
        },
        {
            name: 'missing provided contract',
            coreVersion: '0.7.0',
            requiredApiContracts: {
                'new-contract': '>=1.0.0',
            },
            providedApiContracts,
            expectedCompatible: false,
            expectedReasonIncludes: 'not provided by core',
        },
        {
            name: 'provided contract version mismatch',
            coreVersion: '0.7.0',
            requiredApiContracts: {
                'roll-engine-api': '>=2.0.0',
            },
            providedApiContracts,
            expectedCompatible: false,
            expectedReasonIncludes: 'does not satisfy constraint',
        },
        {
            name: 'invalid contract range token',
            coreVersion: '0.7.0',
            requiredApiContracts: {
                'module-api': '^1.0.0',
            },
            providedApiContracts,
            expectedCompatible: false,
            expectedReasonIncludes: 'invalid constraint',
        },
    ];

    for (const testCase of matrix) {
        const result = resolveModuleCompatibility({
            coreVersion: testCase.coreVersion,
            requiredCoreVersion: testCase.requiredCoreVersion,
            requiredApiContracts: testCase.requiredApiContracts,
            providedApiContracts: testCase.providedApiContracts,
        });

        assert.equal(
            result.compatible,
            testCase.expectedCompatible,
            `Case failed: ${testCase.name}`,
        );

        if (testCase.expectedReasonIncludes) {
            assert.equal(
                result.reason?.includes(testCase.expectedReasonIncludes),
                true,
                `Expected reason to include "${testCase.expectedReasonIncludes}" for case: ${testCase.name}`,
            );
        }
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        run();
        console.log('module-compatibility-matrix.test.ts passed');
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}
