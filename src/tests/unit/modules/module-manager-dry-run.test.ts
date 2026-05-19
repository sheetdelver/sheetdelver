import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    __resetRegistryForTests,
    dryRunInstallManagedModule,
    dryRunUpgradeManagedModule,
} from '@modules/registry/server';

const STATE_ENV = 'SHEET_DELVER_MODULE_STATE_FILE';
const ARTIFACT_ENV = 'SHEET_DELVER_MODULE_ARTIFACT_FILE';
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

interface StoredArtifacts {
    version: 1;
    artifacts: Record<string, {
        moduleId: string;
        version: string;
        source: string;
        permissions?: {
            sensitiveData?: string[];
            adminRoutes?: boolean;
        };
    }>;
}

interface StoredLifecycle {
    version: 1;
    modules: Record<string, {
        moduleId: string;
        status: string;
        enabled: boolean;
    }>;
}

export async function run(): Promise<void> {
    const previousStateFile = process.env[STATE_ENV];
    const previousArtifactFile = process.env[ARTIFACT_ENV];
    const previousIndexFile = process.env[INDEX_ENV];

    const stateFilePath = mkTempFile('sheet-delver-dryrun-state');
    const artifactFilePath = mkTempFile('sheet-delver-dryrun-artifacts');
    const indexFilePath = mkTempFile('sheet-delver-dryrun-index');

    try {
        process.env[STATE_ENV] = stateFilePath;
        process.env[ARTIFACT_ENV] = artifactFilePath;

        writeJson(stateFilePath, {
            version: 1,
            modules: {
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

        __resetRegistryForTests();
        const failedInstallPreview = await dryRunInstallManagedModule({
            moduleId: 'shadowdark',
            source: 'https://example.com/modules/shadowdark-2.0.0.tgz',
            version: '2.0.0',
            integrity: 'invalid-digest',
        });
        assert.equal(failedInstallPreview.wouldProceed, false);
        assert.equal(failedInstallPreview.artifactVerification.verified, false);

        delete process.env[INDEX_ENV];
        __resetRegistryForTests();
        const missingIndexPreview = await dryRunUpgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'index://official',
            targetVersion: '3.0.0',
        });
        assert.equal(missingIndexPreview.wouldProceed, false);
        assert.equal(missingIndexPreview.blockingReasons.some((entry) => entry.includes('Failed to fetch remote indexes')), true);

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
        const escalationPreview = await dryRunUpgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'index://official',
            targetVersion: '3.0.0',
        });
        assert.equal(escalationPreview.wouldProceed, false);
        assert.equal(escalationPreview.permissionDelta?.escalated, true);
        assert.equal(escalationPreview.blockingReasons.some((entry) => entry.includes('Permission escalation requires explicit approval')), true);

        __resetRegistryForTests();
        const approvedPreview = await dryRunUpgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'index://official',
            targetVersion: '3.0.0',
            approvePermissionEscalation: true,
        });
        assert.equal(approvedPreview.wouldProceed, true);

        // Dry-run must not mutate persisted artifacts.
        const afterDryRunArtifacts = readJson<StoredArtifacts>(artifactFilePath);
        assert.equal(afterDryRunArtifacts.artifacts.shadowdark?.version, '1.0.0');
        assert.equal(afterDryRunArtifacts.artifacts.shadowdark?.source, 'local://shadowdark');

        // Dry-run must not mutate lifecycle state.
        const afterDryRunLifecycle = readJson<StoredLifecycle>(stateFilePath);
        assert.equal(afterDryRunLifecycle.modules.shadowdark?.status, 'disabled');
        assert.equal(afterDryRunLifecycle.modules.shadowdark?.enabled, false);

        console.log('module-manager-dry-run: PASS');
    } finally {
        __resetRegistryForTests();

        if (previousStateFile !== undefined) process.env[STATE_ENV] = previousStateFile;
        else delete process.env[STATE_ENV];

        if (previousArtifactFile !== undefined) process.env[ARTIFACT_ENV] = previousArtifactFile;
        else delete process.env[ARTIFACT_ENV];

        if (previousIndexFile !== undefined) process.env[INDEX_ENV] = previousIndexFile;
        else delete process.env[INDEX_ENV];

        if (fs.existsSync(stateFilePath)) fs.unlinkSync(stateFilePath);
        if (fs.existsSync(artifactFilePath)) fs.unlinkSync(artifactFilePath);
        if (fs.existsSync(indexFilePath)) fs.unlinkSync(indexFilePath);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
