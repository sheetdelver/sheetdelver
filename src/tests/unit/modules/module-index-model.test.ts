import { strict as assert } from 'node:assert';
import {
    resolveIndexedModuleVersion,
    validateModuleIndexDocument,
    type ModuleIndexDocument,
} from '@modules/registry/moduleIndex';

function buildValidIndex(): ModuleIndexDocument {
    return {
        schemaVersion: 'module-index.v1',
        generatedAt: Date.now(),
        publisher: 'sheetdelver',
        modules: {
            shadowdark: {
                moduleId: 'shadowdark',
                title: 'Shadowdark RPG',
                latestVersion: '1.2.0',
                versions: {
                    '1.1.0': {
                        source: 'https://example.invalid/shadowdark-1.1.0.tgz',
                        integrity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    },
                    '1.2.0': {
                        source: 'https://example.invalid/shadowdark-1.2.0.tgz',
                        signature: 'minisign:abcdef',
                    },
                },
            },
        },
    };
}

export function run() {
    const valid = buildValidIndex();
    const validResult = validateModuleIndexDocument(valid);
    assert.equal(validResult.valid, true);
    assert.equal(validResult.errors.length, 0);

    const invalidLatest = buildValidIndex();
    invalidLatest.modules.shadowdark.latestVersion = '9.9.9';
    const invalidLatestResult = validateModuleIndexDocument(invalidLatest);
    assert.equal(invalidLatestResult.valid, false);
    assert.equal(
        invalidLatestResult.errors.some((error) => error.includes('latestVersion')),
        true,
    );

    const resolvedLatest = resolveIndexedModuleVersion(valid, 'shadowdark');
    assert.equal(resolvedLatest.ok, true);
    assert.equal(resolvedLatest.value?.version, '1.2.0');

    const resolvedSpecific = resolveIndexedModuleVersion(valid, 'shadowdark', '1.1.0');
    assert.equal(resolvedSpecific.ok, true);
    assert.equal(resolvedSpecific.value?.artifact.source.includes('1.1.0'), true);

    const missingModule = resolveIndexedModuleVersion(valid, 'missing-module');
    assert.equal(missingModule.ok, false);
    assert.equal(missingModule.error?.includes('was not found in index'), true);

    const missingVersion = resolveIndexedModuleVersion(valid, 'shadowdark', '0.0.1');
    assert.equal(missingVersion.ok, false);
    assert.equal(missingVersion.error?.includes('does not have published version'), true);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        run();
        console.log('module-index-model.test.ts passed');
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}
