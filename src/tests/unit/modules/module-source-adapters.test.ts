import { strict as assert } from 'node:assert';
import {
    directModuleSourceAdapter,
    getDefaultModuleSourceAdapters,
    indexedModuleSourceAdapter,
    localModuleSourceAdapter,
    resolveModuleSource,
} from '@modules/registry/sourceAdapters';
import type { ModuleIndexDocument } from '@modules/registry/moduleIndex';
import {
    REMOTE_MODULE_DISTRIBUTION_ERROR_CODE,
    REMOTE_MODULE_DISTRIBUTION_ERROR_MESSAGE,
} from '@modules/registry/security/remoteDistributionPolicy';

function buildIndex(): ModuleIndexDocument {
    return {
        schemaVersion: 'module-index.v1',
        generatedAt: Date.now(),
        publisher: 'sheetdelver',
        modules: {
            generic: {
                moduleId: 'generic',
                title: 'Generic System',
                latestVersion: '1.0.1',
                versions: {
                    '1.0.0': {
                        source: 'https://example.invalid/generic-1.0.0.tgz',
                    },
                    '1.0.1': {
                        source: 'https://example.invalid/generic-1.0.1.tgz',
                        integrity: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                    },
                },
            },
        },
    };
}

export function run() {
    assert.equal(localModuleSourceAdapter.canHandle('local://generic'), true);
    assert.equal(localModuleSourceAdapter.canHandle('file:///tmp/generic.tgz'), true);
    assert.equal(localModuleSourceAdapter.canHandle('index://official'), false);

    const localResolved = localModuleSourceAdapter.resolve({
        moduleId: 'generic',
        sourceRef: 'local://generic',
        targetVersion: 'dev-build',
    });
    assert.equal(localResolved.ok, true);
    assert.equal(localResolved.value?.kind, 'local');
    assert.equal(localResolved.value?.source, 'local://generic');

    assert.equal(indexedModuleSourceAdapter.canHandle('index://official'), true);
    assert.equal(indexedModuleSourceAdapter.canHandle('https://example.invalid/index.json'), false);

    assert.equal(directModuleSourceAdapter.canHandle('https://example.invalid/module.tgz'), true);
    assert.equal(directModuleSourceAdapter.canHandle('http://example.invalid/module.tgz'), true);
    assert.equal(directModuleSourceAdapter.canHandle('ftp://example.invalid/module.tgz'), false);

    // Remote adapters remain identifiable as dormant scaffolding, but direct
    // invocation must fail closed until a future ADR activates distribution.
    const directResolved = directModuleSourceAdapter.resolve({
        moduleId: 'generic',
        sourceRef: 'https://example.invalid/generic-2.0.0.tgz',
        targetVersion: '2.0.0',
    });
    assert.equal(directResolved.ok, false);
    assert.equal(directResolved.errorCode, REMOTE_MODULE_DISTRIBUTION_ERROR_CODE);
    assert.equal(directResolved.error, REMOTE_MODULE_DISTRIBUTION_ERROR_MESSAGE);

    const noContext = indexedModuleSourceAdapter.resolve({
        moduleId: 'generic',
        sourceRef: 'index://official',
    });
    assert.equal(noContext.ok, false);
    assert.equal(noContext.errorCode, REMOTE_MODULE_DISTRIBUTION_ERROR_CODE);
    assert.equal(noContext.error, REMOTE_MODULE_DISTRIBUTION_ERROR_MESSAGE);

    const indexResolved = indexedModuleSourceAdapter.resolve(
        {
            moduleId: 'generic',
            sourceRef: 'index://official',
        },
        {
            indexes: {
                'index://official': buildIndex(),
            },
        }
    );
    assert.equal(indexResolved.ok, false);
    assert.equal(indexResolved.errorCode, REMOTE_MODULE_DISTRIBUTION_ERROR_CODE);
    assert.equal(indexResolved.error, REMOTE_MODULE_DISTRIBUTION_ERROR_MESSAGE);

    const adapters = getDefaultModuleSourceAdapters();
    assert.deepEqual(adapters.map(adapter => adapter.kind), ['local']);

    // Supplying an otherwise valid index context cannot bypass the active
    // adapter set or re-enable remote resolution through configuration.
    const resolvedWithSelection = resolveModuleSource(
        adapters,
        {
            moduleId: 'generic',
            sourceRef: 'index://official',
            targetVersion: '1.0.0',
        },
        {
            indexes: {
                'index://official': buildIndex(),
            },
        }
    );
    assert.equal(resolvedWithSelection.ok, false);
    assert.equal(resolvedWithSelection.errorCode, REMOTE_MODULE_DISTRIBUTION_ERROR_CODE);
    assert.equal(resolvedWithSelection.error, REMOTE_MODULE_DISTRIBUTION_ERROR_MESSAGE);

    const missingAdapter = resolveModuleSource(adapters, {
        moduleId: 'generic',
        sourceRef: 'ftp://example.invalid/not-supported',
    });
    assert.equal(missingAdapter.ok, false);
    assert.equal(missingAdapter.error?.includes('No module source adapter found'), true);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        run();
        console.log('module-source-adapters.test.ts passed');
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}
