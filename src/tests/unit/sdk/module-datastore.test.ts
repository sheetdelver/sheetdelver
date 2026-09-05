import { strict as assert } from 'node:assert';
import {
    validateDataStoreKey,
    validateDataStorePrefix,
} from '@server/shared/utils/createModuleRuntime';
import { isSdkError } from '@shared/sdk';

function assertValidationError(fn: () => unknown) {
    assert.throws(fn, (error: unknown) => isSdkError(error) && error.code === 'validation');
}

export async function run() {
    assert.equal(validateDataStoreKey('preferences'), 'preferences');
    assert.equal(validateDataStoreKey('index:v1'), 'index:v1');
    assert.equal(validateDataStorePrefix(), undefined);
    assert.equal(validateDataStorePrefix('index:'), 'index:');

    for (const key of ['', '.', '..', 'a/b', 'a\\b', `a${'\0'}b`, 'datastore', 'compendiums', 'manifest', 'Manifest']) {
        assertValidationError(() => validateDataStoreKey(key));
    }

    for (const prefix of ['.', '..', 'a/b', 'a\\b', `a${'\0'}b`]) {
        assertValidationError(() => validateDataStorePrefix(prefix));
    }

    console.log('  - module DataStore key validation: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('module-datastore.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
