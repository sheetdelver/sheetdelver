import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistentCache } from '@core/cache/PersistentCache';
import {
    __resetDataDirForTests,
    getDataDir,
    initDataDir,
    OWNER_ONLY_DIRECTORY_MODE,
    OWNER_ONLY_FILE_MODE,
    writeOwnerOnlyFileAtomicSync,
} from '@core/paths';

function permissionMode(targetPath: string): number {
    return fs.statSync(targetPath).mode & 0o777;
}

function assertMode(targetPath: string, expected: number): void {
    assert.equal(
        permissionMode(targetPath),
        expected,
        `${targetPath} should use mode ${expected.toString(8)}`,
    );
}

/** Exercise migration and new writes without touching the configured data tree. */
export async function run(): Promise<void> {
    console.log('Running sensitive file permission tests...');

    // The full runner initializes this globally, while direct execution does not.
    let previousDataDir: string | null = null;
    try {
        previousDataDir = getDataDir();
    } catch {
        // A null resolver state is restored after standalone execution.
    }
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-sensitive-files-'));
    const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-sensitive-symlink-'));

    try {
        const sensitiveDirectories = [
            'config',
            'security',
            'cache',
            path.join('cache', 'core'),
        ];
        const sensitiveFiles = [
            path.join('config', 'settings.yaml'),
            path.join('security', 'admin-auth.json'),
            path.join('security', 'admin-audit.ndjson'),
            path.join('modules', 'sources.json'),
            path.join('cache', 'core', 'sessions.json'),
        ];

        // Model an installation created before owner-only modes were enforced.
        for (const directory of [...sensitiveDirectories, 'modules']) {
            const directoryPath = path.join(testRoot, directory);
            fs.mkdirSync(directoryPath, { recursive: true });
            if (process.platform !== 'win32') fs.chmodSync(directoryPath, 0o755);
        }
        for (const file of sensitiveFiles) {
            const filePath = path.join(testRoot, file);
            fs.writeFileSync(filePath, '{}\n', 'utf8');
            if (process.platform !== 'win32') fs.chmodSync(filePath, 0o644);
        }

        initDataDir(testRoot);

        if (process.platform !== 'win32') {
            for (const directory of sensitiveDirectories) {
                assertMode(path.join(testRoot, directory), OWNER_ONLY_DIRECTORY_MODE);
            }
            for (const file of sensitiveFiles) {
                assertMode(path.join(testRoot, file), OWNER_ONLY_FILE_MODE);
            }
        }

        const settingsPath = path.join(testRoot, 'config', 'settings.yaml');
        writeOwnerOnlyFileAtomicSync(settingsPath, 'server:\n  port: 3001\n');
        assert.equal(fs.readFileSync(settingsPath, 'utf8'), 'server:\n  port: 3001\n');
        if (process.platform !== 'win32') assertMode(settingsPath, OWNER_ONLY_FILE_MODE);
        assert.equal(
            fs.readdirSync(path.dirname(settingsPath)).some((entry) => entry.endsWith('.tmp')),
            false,
            'atomic sensitive writes should not leave temporary files behind',
        );

        // Reflect.construct keeps the singleton used by the rest of the suite
        // bound to its original data directory while exercising a fresh cache.
        const isolatedCache = Reflect.construct(PersistentCache, []) as PersistentCache;
        await isolatedCache.set('mode-test', 'private-record', { secret: true });
        const cacheNamespace = path.join(testRoot, 'cache', 'mode-test');
        const cacheFile = path.join(cacheNamespace, 'private-record.json');
        assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')), { secret: true });
        if (process.platform !== 'win32') {
            assertMode(cacheNamespace, OWNER_ONLY_DIRECTORY_MODE);
            assertMode(cacheFile, OWNER_ONLY_FILE_MODE);
        }

        if (process.platform !== 'win32') {
            const externalConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-external-config-'));
            try {
                fs.symlinkSync(externalConfig, path.join(symlinkRoot, 'config'), 'dir');
                assert.throws(
                    () => initDataDir(symlinkRoot),
                    /symbolic links are not allowed for sensitive directories/,
                    'startup should reject a sensitive directory symlink',
                );
            } finally {
                fs.rmSync(externalConfig, { recursive: true, force: true });
            }
        }
    } finally {
        // Restore shared resolver state before later unit tests initialize services.
        if (previousDataDir) initDataDir(previousDataDir);
        else __resetDataDirForTests(null);
        fs.rmSync(testRoot, { recursive: true, force: true });
        fs.rmSync(symlinkRoot, { recursive: true, force: true });
    }

    console.log('  Sensitive file permission tests passed');
}
