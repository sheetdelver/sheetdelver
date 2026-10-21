import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractReleaseNotes, versionFromReleaseTag } from './release-notes.mjs';

test('metadata-only CI prepares current notes and SBOM without installing any dependencies', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-sbom-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pkg = { name: 'fixture', version: '1.0.1' };
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { '': pkg } }));
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '## 1.0.1\n- New release\n\n## 1.0.0\n- Old notes');
    execFileSync(process.execPath, [new URL('./release-notes.mjs', import.meta.url).pathname, path.join(root, 'release-notes.md')], { cwd: root });
    assert.equal(fs.readFileSync(path.join(root, 'release-notes.md'), 'utf8'), '- New release\n');
    const sbom = JSON.parse(execFileSync('npm', ['sbom', '--omit=dev', '--sbom-format', 'cyclonedx', '--package-lock-only', '--offline'], { cwd: root, encoding: 'utf8' }));
    assert.equal(sbom.metadata.component.version, '1.0.1');
    assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
});

test('shared parser rejects missing, duplicate, empty headings and invalid version tags', () => {
    assert.equal(versionFromReleaseTag('v1.0.1'), '1.0.1');
    assert.throws(() => versionFromReleaseTag('1.0.1'), /stable/);
    assert.throws(() => extractReleaseNotes('## 1.0.0\n- Older', '1.0.1'), /missing/);
    assert.throws(() => extractReleaseNotes('## 1.0.1\n- One\n## 1.0.1\n- Two', '1.0.1'), /duplicate/);
    assert.throws(() => extractReleaseNotes('## 1.0.1\nNothing', '1.0.1'), /bullet/);
});
