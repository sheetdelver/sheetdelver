import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '@shared/utils/logger';
import {
    __resetRegistryForTests,
    dryRunInstallManagedModule,
    dryRunUpgradeManagedModule,
    upgradeManagedModule,
} from '@modules/registry/server';
import { REMOTE_MODULE_DISTRIBUTION_ERROR_CODE } from '@modules/registry/security/remoteDistributionPolicy';

const STATE_ENV = 'SHEET_DELVER_MODULE_STATE_FILE';
const ARTIFACT_ENV = 'SHEET_DELVER_MODULE_ARTIFACT_FILE';
const INDEX_ENV = 'SHEET_DELVER_MODULE_INDEX_FILE';

function mkTempFile(prefix: string): string {
    return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

function writeJson(filePath: string, value: unknown): void {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

export async function run(): Promise<void> {
    const previousStateFile = process.env[STATE_ENV];
    const previousArtifactFile = process.env[ARTIFACT_ENV];
    const previousIndexFile = process.env[INDEX_ENV];

    const stateFilePath = mkTempFile('sheet-delver-telemetry-state');
    const artifactFilePath = mkTempFile('sheet-delver-telemetry-artifacts');

    const infoMessages: string[] = [];
    const warnMessages: string[] = [];
    const originalInfo = logger.info;
    const originalWarn = logger.warn;

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

        logger.info = ((message: string, ...args: unknown[]) => {
            infoMessages.push([message, ...args.map(String)].join(' '));
        }) as typeof logger.info;

        logger.warn = ((message: string, ...args: unknown[]) => {
            warnMessages.push([message, ...args.map(String)].join(' '));
        }) as typeof logger.warn;

        delete process.env[INDEX_ENV];
        __resetRegistryForTests();
        const sourceFailure = await upgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'index://official',
            targetVersion: '3.0.0',
        });
        assert.equal(sourceFailure.success, false);
        assert.equal(sourceFailure.errorCode, REMOTE_MODULE_DISTRIBUTION_ERROR_CODE);
        assert.equal(
            warnMessages.some((entry) => (
                entry.includes('[ModuleManagerTelemetry]')
                && entry.includes('"stage":"source-resolution"')
                && entry.includes('"operation":"upgrade"')
                && entry.includes(`"errorCode":"${REMOTE_MODULE_DISTRIBUTION_ERROR_CODE}"`)
            )),
            true,
        );

        __resetRegistryForTests();
        const permissionPreview = await dryRunUpgradeManagedModule({
            moduleId: 'shadowdark',
            source: 'local://shadowdark',
            targetVersion: '2.0.0',
            permissions: {
                sensitiveData: ['actor', 'chat'],
                adminRoutes: true,
            },
        });
        assert.equal(permissionPreview.wouldProceed, false);
        assert.equal(
            warnMessages.some((entry) => (
                entry.includes('[ModuleManagerTelemetry]')
                && entry.includes('"stage":"permission-policy"')
                && entry.includes('"operation":"dry-run-upgrade"')
                && entry.includes('"errorCode":"permission-escalation-requires-approval"')
            )),
            true,
        );

        __resetRegistryForTests();
        const installPreview = await dryRunInstallManagedModule({
            moduleId: 'shadowdark',
            source: 'local://shadowdark',
            version: '1.1.0',
        });
        assert.equal(installPreview.wouldProceed, true);
        assert.equal(
            infoMessages.some((entry) => (
                entry.includes('[ModuleManagerTelemetry]')
                && entry.includes('"stage":"summary"')
                && entry.includes('"operation":"dry-run-install"')
                && entry.includes('"outcome":"allow"')
            )),
            true,
        );

        console.log('module-manager-telemetry: PASS');
    } finally {
        logger.info = originalInfo;
        logger.warn = originalWarn;
        __resetRegistryForTests();

        if (previousStateFile !== undefined) process.env[STATE_ENV] = previousStateFile;
        else delete process.env[STATE_ENV];

        if (previousArtifactFile !== undefined) process.env[ARTIFACT_ENV] = previousArtifactFile;
        else delete process.env[ARTIFACT_ENV];

        if (previousIndexFile !== undefined) process.env[INDEX_ENV] = previousIndexFile;
        else delete process.env[INDEX_ENV];

        if (fs.existsSync(stateFilePath)) fs.unlinkSync(stateFilePath);
        if (fs.existsSync(artifactFilePath)) fs.unlinkSync(artifactFilePath);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
