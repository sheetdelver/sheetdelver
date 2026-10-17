import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Run the real generator without the ignored files that can mask bootstrap imports. */
export function run(): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-managed-bootstrap-'));
    const workspace = path.join(root, 'workspace');
    const dataDir = path.join(root, 'data');
    try {
        fs.mkdirSync(workspace);
        for (const entry of ['src', 'patches', 'package.json', 'tsconfig.json']) {
            fs.cpSync(path.resolve(entry), path.join(workspace, entry), { recursive: true });
        }
        fs.symlinkSync(path.resolve('node_modules'), path.join(workspace, 'node_modules'), 'dir');
        // Do not inherit project configuration, credentials, loader overrides or
        // module directories. No .env/settings, service or native world is used.
        const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT'].flatMap(key =>
            process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
        const managed = path.join(workspace, '.managed');
        const upgrades = path.join(dataDir, 'config/module-upgrades');
        for (const existingJournal of [false, true]) {
            fs.rmSync(managed, { recursive: true, force: true });
            if (existingJournal) {
                fs.mkdirSync(path.join(upgrades, 'jobs'), { recursive: true });
                fs.writeFileSync(path.join(upgrades, 'jobs/pending.json'), 'unreadable legacy fixture');
            }
            const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/start-server.ts', 'generate-managed'], {
                cwd: workspace, env: { ...env, NODE_ENV: 'test', SHEET_DELVER_DATA: dataDir }, encoding: 'utf8', timeout: 30_000,
            });
            assert.equal(result.status, 0, `clean managed generation failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
            const paths = JSON.parse(fs.readFileSync(path.join(managed, 'tsconfig.paths.json'), 'utf8'));
            assert.deepEqual(paths.compilerOptions.paths['@core/*'], ['../src/server/core/*']);
            assert.ok(fs.existsSync(path.join(managed, 'module-ui-registry.ts')));
            assert.ok(fs.existsSync(path.join(managed, 'postcss-plugin.cjs')));
            assert.doesNotMatch(result.stdout + result.stderr, /Launching Core|Launching Application Shell|Cache Missing/);
            assert.equal(fs.existsSync(path.join(upgrades, 'maintenance.json')), false, 'generation must not restore runtime maintenance');
            if (existingJournal) assert.equal(fs.readFileSync(path.join(upgrades, 'jobs/pending.json'), 'utf8'), 'unreadable legacy fixture');
        }
        console.log('managed-bootstrap: clean alias generation and runtime-recovery isolation PASS');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) run();
