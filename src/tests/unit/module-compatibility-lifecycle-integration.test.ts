import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    __resetRegistryForTests,
    installManagedModule,
    upgradeManagedModule,
    validateManagedModule,
} from '@modules/registry/server';

const STATE_ENV = 'SHEET_DELVER_MODULE_STATE_FILE';
const ARTIFACT_ENV = 'SHEET_DELVER_MODULE_ARTIFACT_FILE';

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
        reason?: string;
        validation?: {
            compatible: boolean;
            requiredApiContracts?: Record<string, string>;
            providedApiContracts?: Record<string, string>;
            contractDiagnostics?: Array<{ contract: string; compatible: boolean; reason?: string }>;
        };
    }>;
}

export async function run(): Promise<void> {
    const previousStateFile = process.env[STATE_ENV];
    const previousArtifactFile = process.env[ARTIFACT_ENV];

    const stateFilePath = mkTempFile('sheet-delver-contract-lifecycle-state');
    const artifactFilePath = mkTempFile('sheet-delver-contract-lifecycle-artifacts');
    const moduleDirName = `compat-contract-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const moduleDirPath = path.join(process.cwd(), 'src', 'modules', moduleDirName);
    const moduleId = moduleDirName;

    try {
        fs.mkdirSync(moduleDirPath, { recursive: true });
        writeJson(path.join(moduleDirPath, 'info.json'), {
            id: moduleId,
            title: 'Compatibility Contract Test Module',
            manifest: {
                ui: 'src/ui/index.tsx',
                logic: 'src/server/Adapter.ts',
            },
            compatibility: {
                apiContracts: {
                    'module-api': '>=2.0.0 <3.0.0',
                },
            },
        });

        writeJson(stateFilePath, {
            version: 1,
            modules: {
                [moduleId]: {
                    moduleId,
                    title: 'Compatibility Contract Test Module',
                    directory: moduleDirName,
                    status: 'discovered',
                    enabled: true,
                    firstSeenAt: 1,
                    lastSeenAt: 1,
                    updatedAt: 1,
                },
            },
        });

        writeJson(artifactFilePath, {
            version: 1,
            artifacts: {},
            verifications: {},
        });

        process.env[STATE_ENV] = stateFilePath;
        process.env[ARTIFACT_ENV] = artifactFilePath;

        __resetRegistryForTests();

        const installResult = await installManagedModule({
            moduleId,
            source: `local://${moduleId}`,
            version: '1.0.0',
        });
        assert.equal(installResult.success, false);
        assert.equal(installResult.errorCode, 'validation-failed');

        const upgradeResult = await upgradeManagedModule({
            moduleId,
            source: `local://${moduleId}`,
            targetVersion: '1.0.1',
        });
        assert.equal(upgradeResult.success, false);
        assert.equal(upgradeResult.errorCode, 'validation-failed');

        const validateResult = validateManagedModule(moduleId);
        assert.equal(validateResult.success, false);
        assert.equal(validateResult.errorCode, 'validation-failed');

        const stored = readJson<StoredLifecycle>(stateFilePath);
        const record = stored.modules[moduleId];
        assert.equal(record.status, 'incompatible');
        assert.equal(record.reason?.includes('Contract module-api 1.0.0 does not satisfy constraint >=2.0.0'), true);
        assert.equal(record.validation?.compatible, false);
        assert.equal(record.validation?.requiredApiContracts?.['module-api'], '>=2.0.0 <3.0.0');
        assert.equal(record.validation?.providedApiContracts?.['module-api'], '1.0.0');
        assert.equal(
            record.validation?.contractDiagnostics?.some((entry) => entry.contract === 'module-api' && entry.compatible === false),
            true,
        );

        console.log('module-compatibility-lifecycle-integration: PASS');
    } finally {
        __resetRegistryForTests();

        if (previousStateFile) process.env[STATE_ENV] = previousStateFile;
        else delete process.env[STATE_ENV];

        if (previousArtifactFile) process.env[ARTIFACT_ENV] = previousArtifactFile;
        else delete process.env[ARTIFACT_ENV];

        if (fs.existsSync(stateFilePath)) fs.unlinkSync(stateFilePath);
        if (fs.existsSync(artifactFilePath)) fs.unlinkSync(artifactFilePath);
        if (fs.existsSync(moduleDirPath)) fs.rmSync(moduleDirPath, { recursive: true, force: true });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
