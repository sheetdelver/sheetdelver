import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { createCiDataFixture } from '../../../scripts/tools/testing/create-ci-data';
import { getDataDir, initDataDir } from '@server/core/paths';

export function run() {
    const originalDataDir = getDataDir();
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-ci-fixture-'));

    try {
        assert.throws(
            () => createCiDataFixture({}),
            /SHEET_DELVER_DATA must explicitly select an isolated CI data directory/,
        );
        assert.throws(
            () => createCiDataFixture({ SHEET_DELVER_DATA: path.join(process.cwd(), 'temp', 'ci-data') }),
            /must be outside the workspace/,
        );

        const settingsPath = createCiDataFixture({ SHEET_DELVER_DATA: fixtureRoot });
        const settings = fs.readFileSync(settingsPath, 'utf8');
        const parsed = yaml.load(settings) as Record<string, unknown>;
        const worldsPath = path.join(fixtureRoot, 'cache', 'core', 'worlds.json');
        const worlds = JSON.parse(fs.readFileSync(worldsPath, 'utf8')) as Record<string, unknown>;

        assert.equal(settingsPath, path.join(fixtureRoot, 'config', 'settings.yaml'));
        assert.equal(fs.statSync(settingsPath).mode & 0o777, process.platform === 'win32' ? 0o666 : 0o600);
        assert.equal(fs.statSync(worldsPath).mode & 0o777, process.platform === 'win32' ? 0o666 : 0o600);
        assert.ok(parsed.app);
        assert.ok(parsed.foundry);
        assert.deepEqual(worlds, { worlds: {}, currentWorldId: null });
        assert.equal(settings.includes('password:'), false);
        assert.equal(settings.includes('service-token:'), false);
        assert.equal(settings.includes('session-key:'), false);

        // A repeated CI setup must fail instead of silently replacing evidence
        // from an earlier step or targeting an operator's existing settings.
        assert.throws(
            () => createCiDataFixture({ SHEET_DELVER_DATA: fixtureRoot }),
            /Refusing to overwrite existing CI settings/,
        );
    } finally {
        initDataDir(originalDataDir);
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
}
