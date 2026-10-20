import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishCore } from './publish-release.mjs';
test('Core publishes validated notes/SBOM without installing or building; refuses moved tags and existing releases', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-publish-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'sheet-delver.cdx.json'), '{"bomFormat":"CycloneDX"}\n');
    fs.writeFileSync(path.join(root, 'release-notes.md'), '- Reviewed notes\n');
    const id = { product: 'core', version: '1.2.3', commit: 'a'.repeat(40), repository: 'example/core' };
    const calls = [], env = { GITHUB_REF: 'refs/tags/v1.2.3' };
    const invoke = (program, args) => {
        calls.push([program, ...args]);
        if (args[0] === 'api') return '[[]]';
        if (program === 'git') return `${'b'.repeat(40)}\trefs/tags/v1.2.3\n${id.commit}\trefs/tags/v1.2.3^{}\n`;
        return '';
    };
    publishCore(id, root, env, invoke);
    assert.equal(calls.some(call => ['npm', 'npx'].includes(call[0])), false);
    assert.equal(calls.filter(call => call[1] === 'release' && call[2] === 'create').length, 1);
    assert.deepEqual(fs.readFileSync(path.join(root, 'sheet-delver-v1.2.3.cdx.json')), fs.readFileSync(path.join(root, 'sheet-delver.cdx.json')));
    assert.throws(() => publishCore(id, root, env, () => '[[{"tag_name":"v1.2.3"}]]'), /already exists/);
    assert.throws(() => publishCore(id, root, env, (program, args) => program === 'git' ? '' : invoke(program, args)), /tag changed/);
});
