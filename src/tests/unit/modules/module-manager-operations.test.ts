import assert from 'node:assert/strict';
import {
    installModule,
    uninstallModule,
    upgradeModule,
    ManagerOperationError,
    type InstallModuleInput,
    type UpgradeModuleInput,
} from '@modules/registry/manager';
import {
    type ModuleLifecycleStore,
    type ModuleLifecycleRecord,
} from '@modules/registry/lifecycle';
import {
    type ModuleArtifactStore,
    getArtifact,
} from '@modules/registry/artifactStore';
import { __resetDataDirForTests, initDataDir, resolveDataDir } from '@server/core/paths';
import {
    REMOTE_MODULE_DISTRIBUTION_ERROR_CODE,
    REMOTE_MODULE_DISTRIBUTION_ERROR_MESSAGE,
} from '@modules/registry/security/remoteDistributionPolicy';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLifecycleStore(record: ModuleLifecycleRecord): ModuleLifecycleStore {
    return {
        version: 1,
        modules: { [record.moduleId]: record },
    };
}

function makeArtifactStore(): ModuleArtifactStore {
    return { version: 1, artifacts: {}, verifications: {} };
}

const NOW = 1_000_000;

function baseRecord(overrides: Partial<ModuleLifecycleRecord> = {}): ModuleLifecycleRecord {
    return {
        moduleId: 'test-module',
        title: 'Test Module',
        directory: '/modules/test-module',
        status: 'discovered',
        enabled: false,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        updatedAt: NOW,
        ...overrides,
    };
}

function stubSaveLifecycle(_store: ModuleLifecycleStore): void { /* no-op in tests */ }
function stubSaveArtifact(_store: ModuleArtifactStore): void { /* no-op in tests */ }

// ---------------------------------------------------------------------------
// We need to bypass the real fs save calls during unit tests.
// The operations call saveLifecycleStore / saveArtifactStore internally.
// We'll stub those by patching the stores after-the-fact (the functions mutate
// the store in-place and we can verify the mutated state directly).
// For file I/O isolation, operations are run against an in-memory store and
// we only assert the returned result + store mutation.
// ---------------------------------------------------------------------------

export async function run(): Promise<void> {

    // ── installModule ────────────────────────────────────────────────────────

    {
        // Success path: discovered → installed → validated
        const lifecycle = makeLifecycleStore(baseRecord({ status: 'discovered' }));
        const artifacts = makeArtifactStore();

        // Monkey-patch save functions to no-ops to avoid fs I/O
        const input: InstallModuleInput = {
            moduleId: 'test-module',
            source: 'local://test-module',
            version: '1.0.0',
        };

        // We need to intercept saveLifecycleStore/saveArtifactStore.
        // Since they're called inside the module, override via dynamic import mock
        // isn't available here. Instead we verify in-memory state after the call.
        // The test runs in a temp CWD to avoid real file writes.
        const origCwd = process.cwd();
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { join } = await import('node:path');
        const tmpDir = mkdtempSync(join(origCwd, '.tmp-manager-test-'));
        try {
            process.chdir(tmpDir);
            __resetDataDirForTests(tmpDir);
            initDataDir(tmpDir);
            const result = await installModule('test-module', input, lifecycle, artifacts, NOW + 1);

            assert.equal(result.success, true, 'install should succeed');
            assert.equal(result.operation, 'install');
            assert.equal(result.previousStatus, 'discovered');
            assert.equal(result.newStatus, 'validated');
            assert.equal(result.moduleId, 'test-module');

            // Store was mutated to validated
            assert.equal(lifecycle.modules['test-module']?.status, 'validated');

            // Artifact was persisted
            const artifact = getArtifact(artifacts, 'test-module');
            assert.ok(artifact, 'Artifact should be stored');
            assert.equal(artifact?.version, '1.0.0');
            assert.equal(artifact?.source, 'local://test-module');
            assert.equal(artifact?.moduleId, 'test-module');
        } finally {
            process.chdir(origCwd);
            rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    {
        // Success path: a new owner-controlled managed module is auto-created.
        const lifecycle: ModuleLifecycleStore = { version: 1, modules: {} };
        const artifacts = makeArtifactStore();
        const input: InstallModuleInput = { moduleId: 'ghost', source: 'local://ghost', version: '1.0.0' };

        const origCwd = process.cwd();
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { join } = await import('node:path');
        const tmpDir = mkdtempSync(join(origCwd, '.tmp-manager-test-'));
        try {
            process.chdir(tmpDir);
            __resetDataDirForTests(tmpDir);
            initDataDir(tmpDir);
            const result = await installModule('ghost', input, lifecycle, artifacts, NOW);
            assert.equal(result.success, true);
            assert.equal(lifecycle.modules['ghost'].status, 'validated');
        } finally {
            process.chdir(origCwd);
            rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    {
        // A direct internal call cannot bypass the managed facade and create a
        // lifecycle/artifact record for a remote source.
        const lifecycle: ModuleLifecycleStore = { version: 1, modules: {} };
        const artifacts = makeArtifactStore();
        const input: InstallModuleInput = {
            moduleId: 'remote-install',
            source: 'https://example.invalid/remote-install.tgz',
            version: '1.0.0',
        };

        const result = await installModule('remote-install', input, lifecycle, artifacts, NOW);
        assert.equal(result.success, false);
        assert.equal(result.errorCode, REMOTE_MODULE_DISTRIBUTION_ERROR_CODE);
        assert.equal(result.error, REMOTE_MODULE_DISTRIBUTION_ERROR_MESSAGE);
        assert.equal(lifecycle.modules['remote-install'], undefined);
        assert.equal(getArtifact(artifacts, 'remote-install'), undefined);
    }

    {
        // Precondition failure: module already in transient state
        const lifecycle = makeLifecycleStore(baseRecord({ status: 'upgrading' }));
        const artifacts = makeArtifactStore();
        const input: InstallModuleInput = { moduleId: 'test-module', source: 'local://test', version: '1.0.0' };

        const origCwd = process.cwd();
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { join } = await import('node:path');
        const tmpDir = mkdtempSync(join(origCwd, '.tmp-manager-test-'));
        try {
            process.chdir(tmpDir);
            __resetDataDirForTests(tmpDir);
            initDataDir(tmpDir);
            const result = await installModule('test-module', input, lifecycle, artifacts, NOW);
            assert.equal(result.success, false);
            assert.ok(result.error?.includes('upgrading'), 'Error should mention transient state');
        } finally {
            process.chdir(origCwd);
            rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    // ── uninstallModule ──────────────────────────────────────────────────────

    {
        // Success path: disabled → uninstalling → removed
        const lifecycle = makeLifecycleStore(baseRecord({ status: 'disabled', enabled: false }));
        const artifacts = makeArtifactStore();
        artifacts.artifacts['test-module'] = {
            moduleId: 'test-module', source: 'local://test', version: '1.0.0', installedAt: NOW,
        };

        const origCwd = process.cwd();
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { join } = await import('node:path');
        const tmpDir = mkdtempSync(join(origCwd, '.tmp-manager-test-'));
        try {
            process.chdir(tmpDir);
            __resetDataDirForTests(tmpDir);
            initDataDir(tmpDir);
            const result = uninstallModule('test-module', lifecycle, artifacts, NOW + 1);

            assert.equal(result.success, true, 'uninstall should succeed');
            assert.equal(result.previousStatus, 'disabled');
            assert.equal(result.newStatus, 'removed');
            assert.equal(lifecycle.modules['test-module'], undefined, 'Module record should be purged');
            assert.equal(getArtifact(artifacts, 'test-module'), undefined, 'Artifact should be removed');
        } finally {
            process.chdir(origCwd);
            rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    {
        // Precondition failure: cannot uninstall an enabled module (transition not allowed)
        const lifecycle = makeLifecycleStore(baseRecord({ status: 'enabled', enabled: true }));
        const artifacts = makeArtifactStore();

        const origCwd = process.cwd();
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { join } = await import('node:path');
        const tmpDir = mkdtempSync(join(origCwd, '.tmp-manager-test-'));
        try {
            process.chdir(tmpDir);
            __resetDataDirForTests(tmpDir);
            initDataDir(tmpDir);
            const result = uninstallModule('test-module', lifecycle, artifacts, NOW);
            assert.equal(result.success, false, 'Cannot uninstall enabled module');
        } finally {
            process.chdir(origCwd);
            rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    // ── upgradeModule ────────────────────────────────────────────────────────

    {
        // Success path: disabled → upgrading → validated
        const lifecycle = makeLifecycleStore(baseRecord({ status: 'disabled', enabled: false }));
        const artifacts = makeArtifactStore();
        artifacts.artifacts['test-module'] = {
            moduleId: 'test-module', source: 'local://test', version: '1.0.0', installedAt: NOW,
        };

        const input: UpgradeModuleInput = {
            source: 'local://test',
            targetVersion: '2.0.0',
        };

        const origCwd = process.cwd();
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { join } = await import('node:path');
        const tmpDir = mkdtempSync(join(origCwd, '.tmp-manager-test-'));
        try {
            process.chdir(tmpDir);
            __resetDataDirForTests(tmpDir);
            initDataDir(tmpDir);
            const result = await upgradeModule('test-module', input, lifecycle, artifacts, NOW + 1);

            assert.equal(result.success, true, 'upgrade should succeed');
            assert.equal(result.previousStatus, 'disabled');
            assert.equal(result.newStatus, 'validated');
            assert.equal(lifecycle.modules['test-module']?.status, 'validated');

            const artifact = getArtifact(artifacts, 'test-module');
            assert.equal(artifact?.version, '2.0.0', 'Artifact version should be updated');
        } finally {
            process.chdir(origCwd);
            rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    {
        // Upgrade from enabled → upgrading → validated
        const lifecycle = makeLifecycleStore(baseRecord({ status: 'enabled', enabled: true }));
        const artifacts = makeArtifactStore();
        artifacts.artifacts['test-module'] = {
            moduleId: 'test-module', source: 'local://test', version: '1.0.0', installedAt: NOW,
        };

        const input: UpgradeModuleInput = { source: 'local://test', targetVersion: '3.0.0' };

        const origCwd = process.cwd();
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { join } = await import('node:path');
        const tmpDir = mkdtempSync(join(origCwd, '.tmp-manager-test-'));
        try {
            process.chdir(tmpDir);
            __resetDataDirForTests(tmpDir);
            initDataDir(tmpDir);
            const result = await upgradeModule('test-module', input, lifecycle, artifacts, NOW + 1);
            assert.equal(result.success, true, 'upgrade from enabled should succeed');
            assert.equal(result.newStatus, 'validated');
        } finally {
            process.chdir(origCwd);
            rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    {
        // Missing module
        const lifecycle: ModuleLifecycleStore = { version: 1, modules: {} };
        const artifacts = makeArtifactStore();
        const input: UpgradeModuleInput = { source: 'local://test', targetVersion: '2.0.0' };

        const origCwd = process.cwd();
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { join } = await import('node:path');
        const tmpDir = mkdtempSync(join(origCwd, '.tmp-manager-test-'));
        try {
            process.chdir(tmpDir);
            __resetDataDirForTests(tmpDir);
            initDataDir(tmpDir);
            const result = await upgradeModule('ghost', input, lifecycle, artifacts, NOW);
            assert.equal(result.success, false);
            assert.ok(result.error?.includes('not found'));
        } finally {
            process.chdir(origCwd);
            rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    {
        // The low-level upgrade transaction also denies remote input before it
        // can enter the upgrading state or replace artifact metadata.
        const lifecycle = makeLifecycleStore(baseRecord({ status: 'disabled' }));
        const artifacts = makeArtifactStore();
        artifacts.artifacts['test-module'] = {
            moduleId: 'test-module', source: 'local://test', version: '1.0.0', installedAt: NOW,
        };
        const input: UpgradeModuleInput = {
            source: 'https://example.invalid/test-module.tgz',
            targetVersion: '2.0.0',
        };

        const result = await upgradeModule('test-module', input, lifecycle, artifacts, NOW + 1);
        assert.equal(result.success, false);
        assert.equal(result.errorCode, REMOTE_MODULE_DISTRIBUTION_ERROR_CODE);
        assert.equal(result.error, REMOTE_MODULE_DISTRIBUTION_ERROR_MESSAGE);
        assert.equal(lifecycle.modules['test-module']?.status, 'disabled');
        assert.equal(getArtifact(artifacts, 'test-module')?.version, '1.0.0');
    }

    // ── ManagerOperationError ────────────────────────────────────────────────

    {
        const err = new ManagerOperationError(
            'transition-rejected',
            'my-module',
            'install',
            'Cannot transition',
            'discovered'
        );
        assert.equal(err.name, 'ManagerOperationError');
        assert.equal(err.code, 'transition-rejected');
        assert.equal(err.moduleId, 'my-module');
        assert.equal(err.operation, 'install');
        assert.equal(err.previousStatus, 'discovered');
        assert.ok(err instanceof Error);
    }

    // ── artifactStore round-trip ─────────────────────────────────────────────

    {
        const origCwd = process.cwd();
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { join } = await import('node:path');
        const tmpDir = mkdtempSync(join(origCwd, '.tmp-artifact-store-'));
        try {
            process.chdir(tmpDir);
            __resetDataDirForTests(tmpDir);
            initDataDir(tmpDir);

            const { loadArtifactStore, saveArtifactStore: save, upsertArtifact: upsert } =
                await import('@modules/registry/artifactStore');

            const store = loadArtifactStore();
            assert.deepEqual(store.artifacts, {}, 'Empty on first load');

            upsert(store, { moduleId: 'alpha', source: 'local://alpha', version: '1.0.0', installedAt: NOW });
            save(store);

            const reloaded = loadArtifactStore();
            assert.ok(reloaded.artifacts['alpha'], 'Persisted artifact should reload');
            assert.equal(reloaded.artifacts['alpha']?.version, '1.0.0');
        } finally {
            process.chdir(origCwd);
            rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    console.log('module-manager-operations: PASS');
}
