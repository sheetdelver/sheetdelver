import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveExternalSecret } from '@server/security/externalSecret';

export function run(): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-external-secret-'));
    try {
        assert.deepEqual(resolveExternalSecret('legacy-value', 'test.secret'), {
            value: 'legacy-value',
            source: 'legacy-inline',
        });
        assert.deepEqual(resolveExternalSecret(
            { env: 'TEST_SECRET' },
            'test.secret',
            { env: { TEST_SECRET: 'environment-value' } },
        ), {
            value: 'environment-value',
            source: 'environment',
        });
        assert.throws(
            () => resolveExternalSecret({ env: 'MISSING' }, 'test.secret', { env: {} }),
            /is not set/,
        );

        const dataDir = path.join(root, 'data');
        const externalPath = path.join(root, 'outside-secret');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(externalPath, 'file-value\n', { mode: 0o600 });
        assert.deepEqual(resolveExternalSecret(
            { file: externalPath },
            'test.secret',
            { dataDir, requireOutsideDataDir: true },
        ), {
            value: 'file-value',
            source: 'file',
        });

        const internalPath = path.join(dataDir, 'secret');
        fs.writeFileSync(internalPath, 'internal', { mode: 0o600 });
        assert.throws(
            () => resolveExternalSecret(
                { file: internalPath },
                'test.secret',
                { dataDir, requireOutsideDataDir: true },
            ),
            /outside <DATA_DIR>/,
        );

        assert.throws(
            () => resolveExternalSecret({ env: 'A', file: externalPath }, 'test.secret'),
            /exactly one/,
        );
        assert.throws(
            () => resolveExternalSecret({ file: 'relative-secret' }, 'test.secret'),
            /absolute path/,
        );

        if (process.platform !== 'win32') {
            const permissivePath = path.join(root, 'permissive-secret');
            fs.writeFileSync(permissivePath, 'unsafe', { mode: 0o644 });
            assert.throws(
                () => resolveExternalSecret({ file: permissivePath }, 'test.secret'),
                /group or other permissions/,
            );
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log('  - external secret references: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}
