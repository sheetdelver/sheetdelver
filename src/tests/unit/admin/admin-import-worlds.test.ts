import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function run() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-admin-import-'));
    const dataDir = path.join(root, 'sheet-delver-data');
    const foundryDataDir = path.join(root, 'foundry-data');
    const worldDir = path.join(foundryDataDir, 'worlds', 'synthetic-world');
    const scriptPath = path.resolve(process.cwd(), 'src/scripts/tools/admin/import-worlds.ts');
    const tsxCliPath = path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');

    try {
        fs.mkdirSync(worldDir, { recursive: true });
        fs.writeFileSync(path.join(worldDir, 'world.json'), JSON.stringify({
            id: 'synthetic-world',
            title: 'Synthetic World',
            system: 'synthetic-system',
            coreVersion: '13.351',
            background: null,
            description: 'Admin import test fixture',
        }));

        // Execute the real CLI in a child process so this test proves it
        // initializes SHEET_DELVER_DATA without relying on the unit runner.
        const result = spawnSync(process.execPath, [tsxCliPath, scriptPath, foundryDataDir], {
            cwd: process.cwd(),
            env: { ...process.env, SHEET_DELVER_DATA: dataDir },
            encoding: 'utf8',
        });

        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const cachePath = path.join(dataDir, 'cache', 'core', 'worlds.json');
        const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
            currentWorldId: string | null;
            worlds: Record<string, { worldTitle?: string }>;
        };
        assert.equal(cache.worlds['synthetic-world']?.worldTitle, 'Synthetic World');
        assert.equal(cache.currentWorldId, 'synthetic-world');
        assert.match(result.stdout, /Successfully imported 1\/1 worlds/);
        console.log('  - admin world import data-root initialization: all checks passed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}
