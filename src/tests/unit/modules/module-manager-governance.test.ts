import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    __resetRegistryForTests,
    installManagedModule,
    upgradeManagedModule,
    uninstallManagedModule,
} from '@modules/registry/server';
import {
    REMOTE_MODULE_DISTRIBUTION_ERROR_CODE,
    REMOTE_MODULE_DISTRIBUTION_ERROR_MESSAGE,
} from '@modules/registry/security/remoteDistributionPolicy';

const STATE_ENV = 'SHEET_DELVER_MODULE_STATE_FILE';
const ARTIFACT_ENV = 'SHEET_DELVER_MODULE_ARTIFACT_FILE';
const FAIL_OPEN_ENV = 'SHEET_DELVER_MANIFEST_FAIL_OPEN';
const INDEX_ENV = 'SHEET_DELVER_MODULE_INDEX_FILE';

function mkTempFile(prefix: string): string {
    return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

function writeJson(filePath: string, value: unknown): void {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readJson<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

interface StoredLifecycle {
    version: 1;
    modules: Record<string, {
        moduleId: string;
        status: string;
        enabled: boolean;
    }>;
}

interface StoredArtifacts {
    version: 1;
    artifacts: Record<string, {
        moduleId: string;
        version: string;
        source: string;
    }>;
    verifications?: Record<string, {
        moduleId: string;
        operation: 'install' | 'upgrade';
        status: 'verified' | 'failed' | 'skipped';
        verified: boolean;
        reason?: string;
        source: string;
        integrity?: string;
        signature?: string;
        checkedAt: number;
    }>;
}

export async function run(): Promise<void> {
    const previousStateFile = process.env[STATE_ENV];
    const previousArtifactFile = process.env[ARTIFACT_ENV];
    const previousFailOpen = process.env[FAIL_OPEN_ENV];
    const previousIndexFile = process.env[INDEX_ENV];

    const stateFilePath = mkTempFile('sheet-delver-state');
    const artifactFilePath = mkTempFile('sheet-delver-artifacts');
    const indexFilePath = mkTempFile('sheet-delver-index');

    try {
        process.env[STATE_ENV] = stateFilePath;
        process.env[ARTIFACT_ENV] = artifactFilePath;

        // Seed with one fake module that failed manifest validation and one real module.
        const { getModulesDataDir, initDataDir, resolveDataDir } = await import('../../../server/core/paths');
        const testDataDir = path.join(os.tmpdir(), `sheet-delver-gov-test-${Date.now()}`);
        if (!fs.existsSync(testDataDir)) fs.mkdirSync(testDataDir, { recursive: true });
        initDataDir(resolveDataDir(['--data-dir', testDataDir]));
        
        const testModulesDir = getModulesDataDir();
        const shadowdarkDir = path.join(testModulesDir, 'shadowdark');
        if (!fs.existsSync(shadowdarkDir)) {
            fs.mkdirSync(shadowdarkDir, { recursive: true });
        }
        writeJson(path.join(shadowdarkDir, 'info.json'), {
            id: 'shadowdark',
            title: 'Shadowdark RPG',
            version: '1.0.0',
            manifest: {
                ui: 'src/ui/index.tsx',
                logic: 'src/server/ShadowdarkAdapter.ts',
            },
        });
        // Keep this managed fixture artifact-valid; governance assertions below are
        // about install/upgrade policy, not packaged entry health.
        const shadowdarkUiPath = path.join(shadowdarkDir, 'src', 'ui', 'index.tsx');
        fs.mkdirSync(path.dirname(shadowdarkUiPath), { recursive: true });
        fs.writeFileSync(shadowdarkUiPath, 'export default function ShadowdarkSheet() { return null; }', 'utf8');
        const shadowdarkLogicPath = path.join(shadowdarkDir, 'src', 'server', 'ShadowdarkAdapter.ts');
        fs.mkdirSync(path.dirname(shadowdarkLogicPath), { recursive: true });
        fs.writeFileSync(shadowdarkLogicPath, 'export default class ShadowdarkAdapter {}', 'utf8');

        writeJson(stateFilePath, {
            version: 1,
            modules: {
                badmod: {
                    moduleId: 'badmod',
                    title: 'Bad Module',
                    directory: 'badmod',
                    status: 'discovered',
                    enabled: false,
                    reason: 'Invalid manifest: missing manifest.logic',
                    validation: {
                        manifestValid: false,
                        validationErrors: ['Manifest field "manifest.logic" must be a non-empty string'],
                        compatible: false,
                        coreVersion: '0.7.0',
                    },
                    firstSeenAt: 1,
                    lastSeenAt: 1,
                    updatedAt: 1,
                },
                shadowdark: {
                    moduleId: 'shadowdark',
                    title: 'Shadowdark RPG',
                    directory: 'shadowdark',
                    status: 'disabled',
                    enabled: true,
                    validation: {
                        manifestValid: true,
                        compatible: true,
                        coreVersion: '0.7.0',
                    },
                    firstSeenAt: 1,
                    lastSeenAt: 1,
                    updatedAt: 1,
                },
            },
        });

        writeJson(artifactFilePath, {
            version: 1,
            artifacts: {
                shadowdark: {
                    moduleId: 'shadowdark',
                    source: 'local://shadowdark',
                    version: '1.0.0',
                    installedAt: 1,
                    permissions: {
                        sensitiveData: ['actor'],
                    },
                },
            },
            verifications: {},
        });

        // Strict mode: invalid manifest should be rejected.
        delete process.env[FAIL_OPEN_ENV];
        __resetRegistryForTests();
        const strictInstall = await installManagedModule({
            moduleId: 'badmod',
            source: 'local://badmod',
            version: '1.0.0',
        });
        assert.equal(strictInstall.success, false, 'Strict manifest gate should reject invalid manifest module');
        assert.equal(strictInstall.errorCode, 'validation-failed');

        // Fail-open mode: same invalid module can proceed in dev mode.
        process.env[FAIL_OPEN_ENV] = 'true';
        __resetRegistryForTests();
        const failOpenInstall = await installManagedModule({
            moduleId: 'badmod',
            source: 'local://badmod',
            version: '1.0.1',
        });
        assert.equal(failOpenInstall.success, true, 'Fail-open should allow install for invalid manifest module');

        const postInstallState = readJson<StoredLifecycle>(stateFilePath);
        assert.equal(postInstallState.modules.badmod?.status, 'validated');

        const postInstallArtifacts = readJson<StoredArtifacts>(artifactFilePath);
        assert.equal(postInstallArtifacts.artifacts.badmod?.version, '1.0.1');

        // Direct remote input must be rejected before artifact verification or
        // persistence, regardless of the metadata supplied by the caller.
        __resetRegistryForTests();
        const verificationFail = await upgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'https://example.com/modules/shadowdark-2.1.0.tgz',
            targetVersion: '2.1.0',
            integrity: 'invalid-digest',
        });
        assert.equal(verificationFail.success, false);
        assert.equal(verificationFail.errorCode, REMOTE_MODULE_DISTRIBUTION_ERROR_CODE);
        assert.equal(verificationFail.error, REMOTE_MODULE_DISTRIBUTION_ERROR_MESSAGE);

        const postVerificationArtifacts = readJson<StoredArtifacts>(artifactFilePath);
        assert.equal(postVerificationArtifacts.verifications?.shadowdark, undefined);
        assert.equal(postVerificationArtifacts.artifacts.shadowdark?.version, '1.0.0');

        // Indexed source should fail when index context is not configured.
        delete process.env[INDEX_ENV];
        __resetRegistryForTests();
        const missingIndexConfig = await upgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'index://official',
            targetVersion: '3.0.0',
        });
        assert.equal(missingIndexConfig.success, false);
        assert.equal(missingIndexConfig.errorCode, REMOTE_MODULE_DISTRIBUTION_ERROR_CODE);
        assert.equal(missingIndexConfig.error, REMOTE_MODULE_DISTRIBUTION_ERROR_MESSAGE);

        // Invalid index file should fail deterministically without mutating persisted artifacts.
        fs.writeFileSync(indexFilePath, '{ invalid-json', 'utf8');
        process.env[INDEX_ENV] = indexFilePath;
        __resetRegistryForTests();
        const invalidIndexConfig = await upgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'index://official',
            targetVersion: '3.0.0',
        });
        assert.equal(invalidIndexConfig.success, false);
        assert.equal(invalidIndexConfig.errorCode, REMOTE_MODULE_DISTRIBUTION_ERROR_CODE);
        assert.equal(invalidIndexConfig.error, REMOTE_MODULE_DISTRIBUTION_ERROR_MESSAGE);

        const postInvalidIndexArtifacts = readJson<StoredArtifacts>(artifactFilePath);
        assert.equal(postInvalidIndexArtifacts.artifacts.shadowdark?.version, '1.0.0');
        assert.equal(postInvalidIndexArtifacts.artifacts.shadowdark?.source, 'local://shadowdark');

        // A valid configured index and an approval flag cannot activate dormant
        // distribution or advance into declared-access/artifact handling.
        writeJson(indexFilePath, {
            schemaVersion: 'module-index.v1',
            generatedAt: Date.now(),
            publisher: 'sheetdelver',
            modules: {
                shadowdark: {
                    moduleId: 'shadowdark',
                    title: 'Shadowdark RPG',
                    latestVersion: '3.0.0',
                    versions: {
                        '3.0.0': {
                            source: 'https://example.com/modules/shadowdark-3.0.0.tgz',
                            integrity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                            signature: 'minisign:shadowdark-3.0.0',
                            permissions: {
                                sensitiveData: ['actor', 'chat'],
                                adminRoutes: true,
                            },
                        },
                    },
                },
            },
        });
        process.env[INDEX_ENV] = indexFilePath;

        __resetRegistryForTests();
        const indexedPermissionBlocked = await upgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'index://official',
            targetVersion: '3.0.0',
        });
        assert.equal(indexedPermissionBlocked.success, false);
        assert.equal(indexedPermissionBlocked.errorCode, REMOTE_MODULE_DISTRIBUTION_ERROR_CODE);
        assert.equal(indexedPermissionBlocked.error, REMOTE_MODULE_DISTRIBUTION_ERROR_MESSAGE);

        __resetRegistryForTests();
        const indexedApproved = await upgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'index://official',
            targetVersion: '3.0.0',
            approvePermissionEscalation: true,
        });
        assert.equal(indexedApproved.success, false);
        assert.equal(indexedApproved.errorCode, REMOTE_MODULE_DISTRIBUTION_ERROR_CODE);
        assert.equal(indexedApproved.error, REMOTE_MODULE_DISTRIBUTION_ERROR_MESSAGE);

        const postIndexedUpgradeArtifacts = readJson<StoredArtifacts>(artifactFilePath);
        assert.equal(postIndexedUpgradeArtifacts.artifacts.shadowdark?.version, '1.0.0');
        assert.equal(postIndexedUpgradeArtifacts.artifacts.shadowdark?.source, 'local://shadowdark');

        // Permission escalation requires explicit approval on upgrade.
        __resetRegistryForTests();
        const permissionBlocked = await upgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'local://shadowdark',
            targetVersion: '2.1.0',
            permissions: {
                sensitiveData: ['actor', 'chat'],
                adminRoutes: true,
            },
        });
        assert.equal(permissionBlocked.success, false);
        assert.equal(permissionBlocked.errorCode, 'permission-escalation-requires-approval');
        assert.equal(permissionBlocked.error?.includes('Permission escalation requires explicit approval'), true);

        __resetRegistryForTests();
        const permissionApproved = await upgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'local://shadowdark',
            targetVersion: '2.1.0',
            permissions: {
                sensitiveData: ['actor', 'chat'],
                adminRoutes: true,
            },
            approvePermissionEscalation: true,
        });
        assert.equal(permissionApproved.success, true);

        const postPermissionApprovalArtifacts = readJson<StoredArtifacts>(artifactFilePath);
        assert.equal(postPermissionApprovalArtifacts.artifacts.shadowdark?.version, '2.1.0');

        // Module truly absent from lifecycle + registry should be module-not-found.
        __resetRegistryForTests();
        const missingUpgrade = await upgradeManagedModule({
            moduleId: 'ghost-module',
            source: 'local://ghost',
            targetVersion: '9.9.9',
        });
        assert.equal(missingUpgrade.success, false);
        assert.equal(missingUpgrade.errorCode, 'module-not-found');

        // Persisted correctness for real managed flows on an existing module.
        delete process.env[FAIL_OPEN_ENV];
        __resetRegistryForTests();
        const upgradeResult = await upgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'local://shadowdark',
            targetVersion: '2.0.0',
        });
        assert.equal(upgradeResult.success, true, 'Managed upgrade should succeed for shadowdark');

        const upgradedState = readJson<StoredLifecycle>(stateFilePath);
        assert.equal(upgradedState.modules.shadowdark?.status, 'validated');

        const upgradedArtifacts = readJson<StoredArtifacts>(artifactFilePath);
        assert.equal(upgradedArtifacts.artifacts.shadowdark?.version, '2.0.0');

        __resetRegistryForTests();
        const uninstallResult = await uninstallManagedModule('shadowdark');
        assert.equal(uninstallResult.success, true, 'Managed uninstall should succeed for shadowdark');

        const uninstalledState = readJson<StoredLifecycle>(stateFilePath);
        assert.equal(uninstalledState.modules.shadowdark, undefined, 'Module record should be purged on uninstall');

        const uninstalledArtifacts = readJson<StoredArtifacts>(artifactFilePath);
        assert.equal(uninstalledArtifacts.artifacts.shadowdark, undefined, 'Artifact should be removed on uninstall');

        console.log('module-manager-governance: PASS');
    } finally {
        __resetRegistryForTests();

        if (previousStateFile) process.env[STATE_ENV] = previousStateFile;
        else delete process.env[STATE_ENV];

        if (previousArtifactFile) process.env[ARTIFACT_ENV] = previousArtifactFile;
        else delete process.env[ARTIFACT_ENV];

        if (previousFailOpen !== undefined) process.env[FAIL_OPEN_ENV] = previousFailOpen;
        else delete process.env[FAIL_OPEN_ENV];

        if (previousIndexFile !== undefined) process.env[INDEX_ENV] = previousIndexFile;
        else delete process.env[INDEX_ENV];

        if (fs.existsSync(stateFilePath)) fs.unlinkSync(stateFilePath);
        if (fs.existsSync(artifactFilePath)) fs.unlinkSync(artifactFilePath);
        if (fs.existsSync(indexFilePath)) fs.unlinkSync(indexFilePath);
    }
}
