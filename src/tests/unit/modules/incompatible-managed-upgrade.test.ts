import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import {
    __resetRegistryForTests,
    applyLocalModuleArchive,
    dryRunLocalModuleArchive,
    initializeRegistry,
    listModuleInventory,
    listModules,
    refreshRegistry,
} from '@modules/registry/server';
import { __resetDataDirForTests, getDataDir, getLocalModulesDataDir, getModulesDataDir, initDataDir } from '@core/paths';

const moduleId = 'incompatible-upgrade-test';

function writePackage(directory: string, version: string, contract: string, id = moduleId): void {
    fs.mkdirSync(path.join(directory, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'info.json'), JSON.stringify({
        id,
        title: 'Incompatible Upgrade Test',
        version,
        manifest: { logic: 'dist/logic.js', ui: 'dist/ui.js' },
        compatibility: { apiContracts: { 'ui-extension-api': contract } },
    }));
    fs.writeFileSync(path.join(directory, 'dist/logic.js'), 'export default class Adapter {}');
    fs.writeFileSync(path.join(directory, 'dist/ui.js'), 'export default function UI() {}');
}

export async function run(): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-incompatible-upgrade-'));
    const previousState = process.env.SHEET_DELVER_MODULE_STATE_FILE;
    const previousArtifacts = process.env.SHEET_DELVER_MODULE_ARTIFACT_FILE;
    let previousDataDir: string | null = null;
    try { previousDataDir = getDataDir(); } catch { /* uninitialized */ }

    try {
        initDataDir(root);
        const modulesDir = getModulesDataDir();
        const managedDir = path.join(modulesDir, moduleId);
        const statePath = path.join(modulesDir, 'state.json');
        const artifactPath = path.join(modulesDir, 'artifacts.json');
        process.env.SHEET_DELVER_MODULE_STATE_FILE = statePath;
        process.env.SHEET_DELVER_MODULE_ARTIFACT_FILE = artifactPath;
        writePackage(managedDir, '1.0.0', '<2.0.0');
        fs.writeFileSync(statePath, JSON.stringify({ version: 1, modules: {
            [moduleId]: {
                moduleId, title: 'Incompatible Upgrade Test', directory: managedDir,
                activeSource: 'managed', status: 'validated', enabled: true,
                managedEnabled: true, firstSeenAt: 1, lastSeenAt: 1, updatedAt: 1,
            },
        } }));
        fs.writeFileSync(artifactPath, JSON.stringify({ version: 1, artifacts: {
            [moduleId]: { moduleId, version: '1.0.0', source: 'local://fixture', installedAt: 1 },
        }, verifications: {} }));

        __resetRegistryForTests();
        initializeRegistry();
        assert.equal(listModules({ includeDisabled: true }).some((entry) => entry.info.id === moduleId), false);
        const installed = listModuleInventory().find((entry) => entry.info.id === moduleId);
        assert.equal(installed?.status, 'incompatible');
        assert.equal(installed?.managed, true);
        assert.equal(installed?.lifecycle.managedEnabled, true);

        const source = path.join(root, 'replacement');
        const archivePath = path.join(root, 'replacement.tgz');
        writePackage(source, '1.1.0', '>=3.0.0 <4.0.0');
        tar.create({ cwd: source, file: archivePath, gzip: true, portable: true, sync: true }, fs.readdirSync(source));
        const input = { archivePath, expectedModuleId: moduleId };
        const installPreview = await dryRunLocalModuleArchive('install', input);
        assert.equal(installPreview.wouldProceed, false);
        assert.match(installPreview.blockingReasons.join(' '), /already installed; use upgrade/);
        const upgradePreview = await dryRunLocalModuleArchive('upgrade', input);
        assert.equal(upgradePreview.wouldProceed, true, upgradePreview.blockingReasons.join('; '));
        const upgrade = await applyLocalModuleArchive('upgrade', input);
        assert.equal(upgrade.success, true, upgrade.error);
        assert.equal(JSON.parse(fs.readFileSync(path.join(managedDir, 'info.json'), 'utf8')).version, '1.1.0');
        assert.notEqual(listModuleInventory().find((entry) => entry.info.id === moduleId)?.status, 'incompatible');

        const disabledId = 'disabled-incompatible';
        const disabledDir = path.join(modulesDir, disabledId);
        writePackage(disabledDir, '1.0.0', '<2.0.0', disabledId);
        const disabledState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        disabledState.modules[disabledId] = {
            moduleId: disabledId, title: disabledId, directory: disabledDir,
            activeSource: 'managed', status: 'disabled', enabled: false,
            managedEnabled: false, firstSeenAt: 1, lastSeenAt: 1, updatedAt: 1,
        };
        fs.writeFileSync(statePath, JSON.stringify(disabledState));
        const disabledArtifacts = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        disabledArtifacts.artifacts[disabledId] = {
            moduleId: disabledId, version: '1.0.0', source: 'local://fixture', installedAt: 1,
        };
        fs.writeFileSync(artifactPath, JSON.stringify(disabledArtifacts));
        refreshRegistry();
        assert.equal(listModuleInventory().find((entry) => entry.info.id === disabledId)?.lifecycle.managedEnabled, false);
        const disabledReplacement = path.join(root, 'disabled-replacement');
        const disabledArchive = path.join(root, 'disabled-replacement.tgz');
        writePackage(disabledReplacement, '1.1.0', '>=3.0.0 <4.0.0', disabledId);
        tar.create({ cwd: disabledReplacement, file: disabledArchive, gzip: true, portable: true, sync: true }, fs.readdirSync(disabledReplacement));
        const disabledUpgrade = await applyLocalModuleArchive('upgrade', {
            archivePath: disabledArchive, expectedModuleId: disabledId,
        });
        assert.equal(disabledUpgrade.success, true, disabledUpgrade.error);
        refreshRegistry();
        const disabledAfterUpgrade = listModuleInventory().find((entry) => entry.info.id === disabledId);
        assert.equal(disabledAfterUpgrade?.lifecycle.managedEnabled, false,
            'upgrade and rescan preserve an explicit disabled preference');
        assert.equal(disabledAfterUpgrade?.enabled, false);

        // Missing half of a managed installation stays visible and gives the
        // same precise blocker for both operations.
        const orphanId = 'orphan-artifact';
        const directoryOnlyId = 'directory-only';
        const artifactStore = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        artifactStore.artifacts[orphanId] = {
            moduleId: orphanId, version: '1.0.0', source: 'local://fixture', installedAt: 1,
        };
        fs.writeFileSync(artifactPath, JSON.stringify(artifactStore));
        writePackage(path.join(modulesDir, directoryOnlyId), '1.0.0', '>=3.0.0 <4.0.0', directoryOnlyId);
        refreshRegistry();
        const orphan = listModuleInventory().find((entry) => entry.info.id === orphanId);
        assert.equal(orphan?.managed, true);
        assert.equal(orphan?.managedDirectoryPresent, false);
        for (const [id, missing] of [[orphanId, 'managed package directory'], [directoryOnlyId, 'artifact record']]) {
            const packageDir = path.join(root, `${id}-replacement`);
            const packageArchive = path.join(root, `${id}-replacement.tgz`);
            writePackage(packageDir, '1.1.0', '>=3.0.0 <4.0.0', id);
            tar.create({ cwd: packageDir, file: packageArchive, gzip: true, portable: true, sync: true }, fs.readdirSync(packageDir));
            for (const operation of ['install', 'upgrade'] as const) {
                const preview = await dryRunLocalModuleArchive(operation, {
                    archivePath: packageArchive, expectedModuleId: id,
                });
                assert.equal(preview.wouldProceed, false);
                assert.match(preview.blockingReasons.join(' '), new RegExp(`incomplete installation: ${missing} missing`));
                const apply = await applyLocalModuleArchive(operation, {
                    archivePath: packageArchive, expectedModuleId: id,
                });
                assert.equal(apply.success, false);
                assert.match(apply.error || '', new RegExp(`incomplete installation: ${missing} missing`));
            }
        }

        // The directory names, never untrusted manifest IDs, own lifecycle
        // records. Scanning B before A makes a wrong-ID overwrite observable.
        const targetId = 'aa-identity-target';
        const sourceId = 'zz-identity-source';
        writePackage(path.join(modulesDir, targetId), '1.0.0', '>=3.0.0 <4.0.0', targetId);
        writePackage(path.join(modulesDir, sourceId), '1.0.0', '>=3.0.0 <4.0.0', targetId);
        refreshRegistry();
        const target = listModuleInventory().find((entry) => entry.info.id === targetId);
        const mismatch = listModuleInventory().find((entry) => entry.info.id === sourceId);
        assert.equal(target?.directory, path.join(modulesDir, targetId));
        assert.equal(mismatch?.status, 'errored');
        assert.match(mismatch?.reason || '', /does not match directory/);
        fs.rmSync(path.join(modulesDir, targetId), { recursive: true });
        refreshRegistry();
        assert.equal(listModuleInventory().some((entry) => entry.info.id === targetId
            && entry.directory === path.join(modulesDir, sourceId)), false,
        'a mismatched manifest cannot impersonate an absent target');

        const mixedId = 'mixed-sources';
        const mixedManaged = path.join(modulesDir, mixedId);
        const mixedLocal = path.join(getLocalModulesDataDir(), mixedId);
        writePackage(mixedManaged, '1.0.0', '<2.0.0', mixedId);
        writePackage(mixedLocal, '1.1.0', '>=3.0.0 <4.0.0', mixedId);
        const mixedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        mixedState.modules[mixedId] = {
            moduleId: mixedId, title: mixedId, directory: mixedLocal,
            activeSource: 'local', status: 'validated', enabled: true,
            localEnabled: true, managedEnabled: false,
            firstSeenAt: 1, lastSeenAt: 1, updatedAt: 1,
        };
        fs.writeFileSync(statePath, JSON.stringify(mixedState));
        const mixedArtifacts = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        mixedArtifacts.artifacts[mixedId] = {
            moduleId: mixedId, version: '1.0.0', source: 'local://fixture', installedAt: 1,
        };
        fs.writeFileSync(artifactPath, JSON.stringify(mixedArtifacts));
        refreshRegistry();
        const localActive = listModuleInventory().find((entry) => entry.info.id === mixedId);
        assert.equal(localActive?.status, 'validated');
        assert.equal(localActive?.lifecycle.sourceStates?.managed?.status, 'incompatible');
        assert.equal(localActive?.lifecycle.localDirectory, mixedLocal);
        assert.equal(localActive?.lifecycle.managedEnabled, false);
        writePackage(mixedManaged, '1.2.0', '>=3.0.0 <4.0.0', mixedId);
        writePackage(mixedLocal, '1.0.0', '<2.0.0', mixedId);
        refreshRegistry();
        const managedActive = listModuleInventory().find((entry) => entry.info.id === mixedId);
        assert.equal(managedActive?.lifecycle.localDirectory, mixedLocal,
            'incompatible local source remains physically visible');
        assert.equal(managedActive?.lifecycle.sourceStates?.local?.status, 'incompatible');
        assert.equal(managedActive?.lifecycle.localEnabled, true,
            'incompatibility preserves previous operator intent');
    } finally {
        __resetRegistryForTests();
        __resetDataDirForTests(previousDataDir);
        if (previousState) process.env.SHEET_DELVER_MODULE_STATE_FILE = previousState;
        else delete process.env.SHEET_DELVER_MODULE_STATE_FILE;
        if (previousArtifacts) process.env.SHEET_DELVER_MODULE_ARTIFACT_FILE = previousArtifacts;
        else delete process.env.SHEET_DELVER_MODULE_ARTIFACT_FILE;
        fs.rmSync(root, { recursive: true, force: true });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().then(() => console.log('incompatible-managed-upgrade.test.ts passed'))
        .catch((error) => { console.error(error); process.exit(1); });
}
