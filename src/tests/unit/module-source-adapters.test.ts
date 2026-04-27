import { strict as assert } from 'node:assert';
import {
    getDefaultModuleSourceAdapters,
    indexedModuleSourceAdapter,
    localModuleSourceAdapter,
    resolveModuleSource,
} from '@modules/registry/sourceAdapters';
import type { ModuleIndexDocument } from '@modules/registry/moduleIndex';

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

    const noContext = indexedModuleSourceAdapter.resolve({
        moduleId: 'generic',
        sourceRef: 'index://official',
    });
    assert.equal(noContext.ok, false);
    assert.equal(noContext.error?.includes('not available in resolution context'), true);

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
    assert.equal(indexResolved.ok, true);
    assert.equal(indexResolved.value?.kind, 'indexed');
    assert.equal(indexResolved.value?.version, '1.0.1');
    assert.equal(indexResolved.value?.publisher, 'sheetdelver');

    const adapters = getDefaultModuleSourceAdapters();
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
    assert.equal(resolvedWithSelection.ok, true);
    assert.equal(resolvedWithSelection.value?.version, '1.0.0');

    const missingAdapter = resolveModuleSource(adapters, {
        moduleId: 'generic',
        sourceRef: 'https://example.invalid/not-supported',
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
