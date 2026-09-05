import { strict as assert } from 'node:assert';
import { ModuleSourceCategory } from '@shared/types/modules';
import { resolveUIModuleForSource } from '@modules/registry/core/uiModuleResolver';
import type { UIModuleManifest } from '@modules/registry/core/types';

function manifest(id: string): UIModuleManifest {
    return {
        info: {
            id,
            title: id,
            manifest: { ui: 'module/ui.tsx', logic: 'module/logic.ts' },
        },
        sheet: async () => ({ default: {} }),
    };
}

export async function run(): Promise<void> {
    let managedRuntimeCalls = 0;
    const localFailure = await resolveUIModuleForSource({
        moduleId: 'local-test',
        source: ModuleSourceCategory.Local,
        localLoader: async () => {
            throw new Error('local loader failed');
        },
        managedLoader: async () => manifest('wrong-managed-static'),
        loadManagedRuntime: async () => {
            managedRuntimeCalls += 1;
            return manifest('wrong-managed-runtime');
        },
    });

    assert.equal(localFailure.manifest, undefined);
    assert.equal(localFailure.failure?.source, ModuleSourceCategory.Local);
    assert.match(localFailure.failure?.message ?? '', /local UI manifest/);
    assert.equal(managedRuntimeCalls, 0, 'a local failure must not probe the managed runtime route');

    const missingLocal = await resolveUIModuleForSource({
        moduleId: 'missing-local-test',
        source: ModuleSourceCategory.Local,
        loadManagedRuntime: async () => {
            managedRuntimeCalls += 1;
            return manifest('wrong-managed-runtime');
        },
    });
    assert.equal(missingLocal.failure?.source, ModuleSourceCategory.Local);
    assert.match(missingLocal.failure?.message ?? '', /No bundled local UI manifest/);
    assert.equal(managedRuntimeCalls, 0, 'a missing local loader must not probe the managed runtime route');

    const managedManifest = manifest('managed-test');
    const managedSuccess = await resolveUIModuleForSource({
        moduleId: 'managed-test',
        source: ModuleSourceCategory.Managed,
        loadManagedRuntime: async () => {
            managedRuntimeCalls += 1;
            return { default: managedManifest, __sdCompiledStyles: 'assets/module.css' };
        },
    });
    assert.equal(managedRuntimeCalls, 1);
    assert.equal(managedSuccess.manifest, managedManifest);
    assert.equal(managedSuccess.compiledStyles, 'assets/module.css');

    const managedFailure = await resolveUIModuleForSource({
        moduleId: 'broken-managed-test',
        source: ModuleSourceCategory.Managed,
        loadManagedRuntime: async () => {
            managedRuntimeCalls += 1;
            throw new Error('managed loader failed');
        },
    });
    assert.equal(managedRuntimeCalls, 2);
    assert.equal(managedFailure.failure?.source, ModuleSourceCategory.Managed);
    assert.match(managedFailure.failure?.message ?? '', /runtime UI manifest/);

    const unknownSource = await resolveUIModuleForSource({
        moduleId: 'unknown-test',
        loadManagedRuntime: async () => {
            managedRuntimeCalls += 1;
            return manifest('wrong-managed-runtime');
        },
    });
    assert.equal(unknownSource.manifest, undefined);
    assert.equal(unknownSource.failure, undefined);
    assert.equal(managedRuntimeCalls, 2, 'unknown lifecycle state must not guess a source');

    console.log('module-ui-source-resolution: PASS');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
