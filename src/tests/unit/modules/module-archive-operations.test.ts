import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import {
    __resetRegistryForTests,
    applyLocalModuleArchive,
    dryRunLocalModuleArchive,
    updateManagedModulePolicy,
} from '@modules/registry/server';
import { getArtifact, loadArtifactStore } from '@modules/registry/artifactStore';
import {
    __resetDataDirForTests,
    getDataDir,
    getModulesDataDir,
    initDataDir,
} from '@core/paths';
import type { SystemModuleInfo } from '@modules/registry/types';

function writePackagedModule(root: string, version: string, adminRoutes = false): void {
    const info: SystemModuleInfo = {
        id: 'collision-module',
        title: 'Collision Module',
        version,
        manifest: {
            logic: 'dist/logic.js',
            ui: 'dist/ui.js',
        },
        compatibility: { coreVersion: '>=0.8.0 <1.0.0' },
        permissions: {
            network: { outbound: false },
            adminRoutes,
        },
    };
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'info.json'), `${JSON.stringify(info, null, 2)}\n`);
    fs.writeFileSync(path.join(root, 'dist', 'logic.js'), `export const version = '${version}';\n`);
    fs.writeFileSync(path.join(root, 'dist', 'ui.js'), 'export default function UI() {}\n');
}

function createArchive(tempRoot: string, version: string, adminRoutes = false): string {
    const source = path.join(tempRoot, `source-${version}`);
    const archive = path.join(tempRoot, `collision-module-${version}.tgz`);
    writePackagedModule(source, version, adminRoutes);
    tar.create({
        cwd: source,
        file: archive,
        gzip: true,
        portable: true,
        sync: true,
    }, fs.readdirSync(source));
    return archive;
}

export async function run() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-archive-operations-'));
    const previousNodeEnv = process.env.NODE_ENV;
    let previousDataDir: string | null = null;
    try {
        try { previousDataDir = getDataDir(); } catch { /* data paths were not initialized */ }
        Reflect.set(process.env, 'NODE_ENV', 'development');
        initDataDir(tempRoot);

        const localModule = path.join(tempRoot, 'local', 'modules', 'collision-module');
        fs.mkdirSync(localModule, { recursive: true });
        fs.writeFileSync(path.join(localModule, 'developer-source.txt'), 'untouched');
        writePackagedModule(localModule, '0.0.0-dev');

        const v1Archive = createArchive(tempRoot, '1.0.0');
        __resetRegistryForTests();
        const preview = await dryRunLocalModuleArchive('install', {
            archivePath: v1Archive,
            expectedModuleId: 'collision-module',
        });
        assert.equal(preview.wouldProceed, true);
        assert.equal(preview.archive?.localSourceCollision, true);

        const install = await applyLocalModuleArchive('install', {
            archivePath: v1Archive,
            expectedModuleId: 'collision-module',
        });
        assert.equal(install.success, true, install.error);
        assert.equal(
            fs.readFileSync(path.join(localModule, 'developer-source.txt'), 'utf8'),
            'untouched',
        );

        const managedModule = path.join(getModulesDataDir(), 'collision-module');
        const installedInfo = JSON.parse(fs.readFileSync(path.join(managedModule, 'info.json'), 'utf8'));
        assert.equal(installedInfo.version, '1.0.0');
        const installedArtifact = getArtifact(loadArtifactStore(), 'collision-module');
        assert.equal(installedArtifact?.version, '1.0.0');
        assert.equal(installedArtifact?.trust?.tier, 'unverified');
        assert.match(installedArtifact?.integrity || '', /^sha256:[a-f0-9]{64}$/);

        const stateAfterInstall = JSON.parse(fs.readFileSync(path.join(getModulesDataDir(), 'state.json'), 'utf8'));
        assert.equal(stateAfterInstall.modules['collision-module'].activeSource, 'local');
        assert.equal(stateAfterInstall.modules['collision-module'].localEnabled, true);
        assert.equal(
            stateAfterInstall.modules['collision-module'].managedEnabled,
            false,
            'installing beside an active local source leaves the managed package dormant',
        );
        assert.equal(stateAfterInstall.modules['collision-module'].sourceStates.managed.enabled, false);

        const v2Archive = createArchive(tempRoot, '2.0.0', true);
        const lockedArtifact = updateManagedModulePolicy('collision-module', { locked: true });
        assert.deepEqual(lockedArtifact?.updatePolicy, { locked: true });
        const lockedUpgrade = await dryRunLocalModuleArchive('upgrade', {
            archivePath: v2Archive,
            expectedModuleId: 'collision-module',
        });
        assert.equal(lockedUpgrade.wouldProceed, false);
        assert.equal(lockedUpgrade.blockingReasons.some((reason) => reason.includes('is locked')), true);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(managedModule, 'info.json'), 'utf8')).version,
            '1.0.0',
        );

        updateManagedModulePolicy('collision-module', { locked: false, pinnedVersion: '1.0.0' });
        const pinnedUpgrade = await dryRunLocalModuleArchive('upgrade', {
            archivePath: v2Archive,
            expectedModuleId: 'collision-module',
        });
        assert.equal(pinnedUpgrade.wouldProceed, false);
        assert.equal(pinnedUpgrade.blockingReasons.some((reason) => reason.includes('pinned to v1.0.0')), true);

        updateManagedModulePolicy('collision-module', { pinnedVersion: '2.0.0' });
        const blockedUpgrade = await dryRunLocalModuleArchive('upgrade', {
            archivePath: v2Archive,
            expectedModuleId: 'collision-module',
        });
        assert.equal(blockedUpgrade.wouldProceed, false);
        assert.equal(
            blockedUpgrade.blockingReasons.some((reason) => reason.includes('Permission escalation requires')),
            true,
        );

        const upgrade = await applyLocalModuleArchive('upgrade', {
            archivePath: v2Archive,
            expectedModuleId: 'collision-module',
            approvePermissionEscalation: true,
        });
        assert.equal(upgrade.success, true, upgrade.error);
        const upgradedInfo = JSON.parse(fs.readFileSync(path.join(managedModule, 'info.json'), 'utf8'));
        assert.equal(upgradedInfo.version, '2.0.0');
        assert.equal(fs.readFileSync(path.join(localModule, 'developer-source.txt'), 'utf8'), 'untouched');
        assert.deepEqual(
            getArtifact(loadArtifactStore(), 'collision-module')?.updatePolicy,
            { locked: false, pinnedVersion: '2.0.0' },
        );

        const stateAfterUpgrade = JSON.parse(fs.readFileSync(path.join(getModulesDataDir(), 'state.json'), 'utf8'));
        assert.equal(stateAfterUpgrade.modules['collision-module'].activeSource, 'local');
    } finally {
        __resetRegistryForTests();
        __resetDataDirForTests(previousDataDir);
        if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
        else Reflect.set(process.env, 'NODE_ENV', previousNodeEnv);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('module-archive-operations.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
