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
                    enabled: false,
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
        const strictInstall = installManagedModule({
            moduleId: 'badmod',
            source: 'local://badmod',
            version: '1.0.0',
        });
        assert.equal(strictInstall.success, false, 'Strict manifest gate should reject invalid manifest module');
        assert.equal(strictInstall.errorCode, 'validation-failed');

        // Fail-open mode: same invalid module can proceed in dev mode.
        process.env[FAIL_OPEN_ENV] = 'true';
        __resetRegistryForTests();
        const failOpenInstall = installManagedModule({
            moduleId: 'badmod',
            source: 'local://badmod',
            version: '1.0.1',
        });
        assert.equal(failOpenInstall.success, true, 'Fail-open should allow install for invalid manifest module');

        const postInstallState = readJson<StoredLifecycle>(stateFilePath);
        assert.equal(postInstallState.modules.badmod?.status, 'validated');

        const postInstallArtifacts = readJson<StoredArtifacts>(artifactFilePath);
        assert.equal(postInstallArtifacts.artifacts.badmod?.version, '1.0.1');

        // Non-local artifact with invalid digest/signature metadata should be blocked and persisted.
        __resetRegistryForTests();
        const verificationFail = upgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'https://example.com/modules/shadowdark-2.1.0.tgz',
            targetVersion: '2.1.0',
            integrity: 'invalid-digest',
        });
        assert.equal(verificationFail.success, false);
        assert.equal(verificationFail.errorCode, 'artifact-verification-failed');

        const postVerificationArtifacts = readJson<StoredArtifacts>(artifactFilePath);
        assert.equal(postVerificationArtifacts.verifications?.shadowdark?.status, 'failed');
        assert.equal(postVerificationArtifacts.verifications?.shadowdark?.verified, false);
        assert.equal(
            postVerificationArtifacts.verifications?.shadowdark?.reason?.includes('sha256:<64 hex>'),
            true,
        );

        // Indexed source should fail when index context is not configured.
        delete process.env[INDEX_ENV];
        __resetRegistryForTests();
        const missingIndexConfig = upgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'index://official',
            targetVersion: '3.0.0',
        });
        assert.equal(missingIndexConfig.success, false);
        assert.equal(missingIndexConfig.errorCode, 'source-resolution-failed');

        // Invalid index file should fail deterministically without mutating persisted artifacts.
        fs.writeFileSync(indexFilePath, '{ invalid-json', 'utf8');
        process.env[INDEX_ENV] = indexFilePath;
        __resetRegistryForTests();
        const invalidIndexConfig = upgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'index://official',
            targetVersion: '3.0.0',
        });
        assert.equal(invalidIndexConfig.success, false);
        assert.equal(invalidIndexConfig.errorCode, 'source-resolution-failed');

        const postInvalidIndexArtifacts = readJson<StoredArtifacts>(artifactFilePath);
        assert.equal(postInvalidIndexArtifacts.artifacts.shadowdark?.version, '1.0.0');
        assert.equal(postInvalidIndexArtifacts.artifacts.shadowdark?.source, 'local://shadowdark');

        // Configure an index and verify indexed metadata feeds permission and artifact checks.
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
        const indexedPermissionBlocked = upgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'index://official',
            targetVersion: '3.0.0',
        });
        assert.equal(indexedPermissionBlocked.success, false);
        assert.equal(indexedPermissionBlocked.errorCode, 'permission-escalation-requires-approval');

        __resetRegistryForTests();
        const indexedApproved = upgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'index://official',
            targetVersion: '3.0.0',
            approvePermissionEscalation: true,
        });
        assert.equal(indexedApproved.success, true);

        const postIndexedUpgradeArtifacts = readJson<StoredArtifacts>(artifactFilePath);
        assert.equal(postIndexedUpgradeArtifacts.artifacts.shadowdark?.version, '3.0.0');
        assert.equal(postIndexedUpgradeArtifacts.artifacts.shadowdark?.source, 'https://example.com/modules/shadowdark-3.0.0.tgz');

        // Reset baseline artifact permissions so local escalation assertions remain independent.
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
            verifications: postIndexedUpgradeArtifacts.verifications || {},
        });

        // Permission escalation requires explicit approval on upgrade.
        __resetRegistryForTests();
        const permissionBlocked = upgradeManagedModule({
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
        const permissionApproved = upgradeManagedModule({
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
        const missingUpgrade = upgradeManagedModule({
            moduleId: 'ghost-module',
            source: 'local://ghost',
            targetVersion: '9.9.9',
        });
        assert.equal(missingUpgrade.success, false);
        assert.equal(missingUpgrade.errorCode, 'module-not-found');

        // Persisted correctness for real managed flows on an existing module.
        delete process.env[FAIL_OPEN_ENV];
        __resetRegistryForTests();
        const upgradeResult = upgradeManagedModule({
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
        const uninstallResult = uninstallManagedModule('shadowdark');
        assert.equal(uninstallResult.success, true, 'Managed uninstall should succeed for shadowdark');

        const uninstalledState = readJson<StoredLifecycle>(stateFilePath);
        assert.equal(uninstalledState.modules.shadowdark?.status, 'removed');

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
