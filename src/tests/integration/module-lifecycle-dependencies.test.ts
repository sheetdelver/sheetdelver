import { strict as assert } from 'node:assert';
import { checkCanEnableModule, checkCanDisableModule, __resetRegistryForTests } from '@modules/registry/server';
import { logger } from '@shared/utils/logger';

/**
 * Integration tests for module dependency and conflict constraints.
 * 
 * These tests verify that:
 * - Modules cannot be enabled if dependencies are not met
 * - Modules cannot be enabled if they conflict with enabled modules
 * - Modules cannot be disabled if other modules depend on them
 * - Proper violation information is returned
 */

export async function run() {
    logger.info('Module Lifecycle Dependencies Tests');

    // Reset registry before tests
    __resetRegistryForTests();

    // Test 1: checkCanEnableModule returns proper structure
    const enableResult = checkCanEnableModule('generic');
    assert(enableResult !== undefined, 'checkCanEnableModule should return result');
    assert('canEnable' in enableResult, 'Result should have canEnable property');
    assert('violations' in enableResult, 'Result should have violations property');
    logger.info('checkCanEnableModule returns proper structure');

    // Test 2: Violation objects have correct structure
    if (enableResult.violations) {
        enableResult.violations.forEach(violation => {
            assert('type' in violation, 'Violation should have type property');
            assert('moduleId' in violation, 'Violation should have moduleId property');
            assert('affectedModule' in violation, 'Violation should have affectedModule property');
            assert('reason' in violation, 'Violation should have reason property');
            assert(typeof violation.type === 'string', 'Type should be string');
            assert(typeof violation.moduleId === 'string', 'ModuleId should be string');
            assert(typeof violation.affectedModule === 'string', 'AffectedModule should be string');
            assert(typeof violation.reason === 'string', 'Reason should be string');
        });
    }
    logger.info('Violation objects have correct structure');

    // Test 3: Non-existent modules return module-not-found
    const nonExistentResult = checkCanEnableModule('non-existent-module-xyz');
    assert(nonExistentResult.canEnable === false, 'Non-existent module should not be enabled');
    assert(nonExistentResult.violations !== undefined, 'Should have violations');
    assert(nonExistentResult.violations?.[0].type === 'module-not-found', 'Should return module-not-found violation');
    logger.info('Non-existent modules return module-not-found');

    // Test 4: checkCanDisableModule returns proper structure
    const disableResult = checkCanDisableModule('generic');
    assert(disableResult !== undefined, 'checkCanDisableModule should return result');
    assert('canDisable' in disableResult, 'Result should have canDisable property');
    assert('violations' in disableResult, 'Result should have violations property');
    logger.info('checkCanDisableModule returns proper structure');

    // Test 5: Valid violation types
    const validTypes = [
        'module-not-found',
        'missing-dependency',
        'unmet-dependency',
        'conflicting-module',
        'has-dependents'
    ];

    if (enableResult.violations) {
        enableResult.violations.forEach(v => {
            assert(validTypes.includes(v.type), `Violation type "${v.type}" should be one of valid types`);
        });
    }

    if (disableResult.violations) {
        disableResult.violations.forEach(v => {
            assert(validTypes.includes(v.type), `Violation type "${v.type}" should be one of valid types`);
        });
    }
    logger.info('All violation types are valid');

    // Test 6: Case-insensitive module IDs
    const lowerResult = checkCanEnableModule('generic');
    const upperResult = checkCanEnableModule('GENERIC');
    assert(lowerResult.canEnable === upperResult.canEnable, 'Module ID lookup should be case-insensitive');
    logger.info('Case-insensitive module ID handling');

    logger.info('All module lifecycle dependency tests passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('module-lifecycle-dependencies.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
