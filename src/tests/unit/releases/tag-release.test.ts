import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseReleaseOptions, planLocalRelease, runLocalRelease, runReleaseCommand, type ReleasePublishIO } from '../../../scripts/tools/releases/tag-release';

export async function run() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-release-tag-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
    const write = (file: string, data: unknown) => fs.writeFileSync(path.join(root, file), JSON.stringify(data, null, 2) + '\n');
    const options = parseReleaseOptions(['v0.11.0', '--note', 'Added shared 3D dice', '--note', 'Added player settings panel']);
    try {
        git('init', '-b', 'main');
        git('config', 'user.name', 'Release Test'); git('config', 'user.email', 'release@example.invalid');
        git('config', 'commit.gpgsign', 'false'); git('config', 'tag.gpgsign', 'false');
        git('config', 'core.hooksPath', path.join(root, '.git', 'hooks'));
        const pkg = { name: 'release-fixture', version: '0.10.2', scripts: { test: 'echo fixture' }, dependencies: { example: '^1.0.0' } };
        const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { version: pkg.version, dependencies: pkg.dependencies }, 'node_modules/example': { version: '1.0.9', integrity: 'unchanged' } } };
        write('package.json', pkg); write('package-lock.json', lock);
        fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Releases\n## 0.10.2\n- Earlier change\n');
        git('add', '.'); git('commit', '-m', 'fixture');
        const initial = git('rev-parse', 'HEAD');
        const original = ['package.json', 'package-lock.json', 'CHANGELOG.md'].map(read);
        const messages: string[] = [];
        const forbiddenIO: ReleasePublishIO = {
            confirm: async () => { throw new Error('Unexpected prompt'); },
            command: () => { throw new Error('Unexpected publish command'); },
            sleep: async () => { throw new Error('Unexpected workflow wait'); },
            now: () => { throw new Error('Unexpected workflow clock'); },
        };
        await runReleaseCommand(root, { ...options, dryRun: true }, forbiddenIO, line => messages.push(line));
        assert.equal(git('rev-parse', 'HEAD'), initial);
        assert.equal(git('tag'), ''); assert.equal(git('status', '--porcelain'), '');
        assert.deepEqual(['package.json', 'package-lock.json', 'CHANGELOG.md'].map(read), original);
        assert.ok(messages.join('\n').includes('0.10.2 -> 0.11.0'));
        assert.ok(messages.join('\n').includes('- Added player settings panel'));

        for (const args of [[], ['nope'], ['0.11.0', '--note'], ['0.11.0', '--note', 'bad\nentry'], ['0.11.0', '--push']]) {
            assert.throws(() => parseReleaseOptions(args));
        }
        assert.equal(parseReleaseOptions(['0.11.0']).tag, 'v0.11.0');
        assert.equal(parseReleaseOptions(['0.11.0', '--no-push']).noPush, true);
        assert.throws(() => planLocalRelease(root, { ...options, tag: 'v0.10.2' }), /must be newer/);
        assert.throws(() => planLocalRelease(root, { ...options, tag: 'v0.9.9' }), /must be newer/);
        assert.throws(() => planLocalRelease(root, { ...options, notes: [] }), /missing the exact heading/);

        fs.writeFileSync(path.join(root, 'unrelated.txt'), 'keep this');
        assert.throws(() => runLocalRelease(root, options, () => {}), /unrelated work/);
        assert.deepEqual(['package.json', 'package-lock.json', 'CHANGELOG.md'].map(read), original);
        fs.unlinkSync(path.join(root, 'unrelated.txt'));
        git('switch', '-c', 'feature/test');
        assert.throws(() => runLocalRelease(root, options, () => {}), /Check out main/);
        assert.equal(git('branch', '--show-current'), 'feature/test');
        git('switch', 'main'); git('branch', '-d', 'feature/test');
        git('tag', 'v0.11.0');
        assert.throws(() => runLocalRelease(root, options, () => {}), /already exists/);
        assert.equal(git('rev-parse', 'v0.11.0'), initial);
        git('tag', '-d', 'v0.11.0');
        write('package-lock.json', { ...lock, version: '0.1.0' });
        assert.throws(() => planLocalRelease(root, options), /must match/);
        fs.writeFileSync(path.join(root, 'package-lock.json'), original[1]);

        fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Releases\n## 0.11.0\n- Added shared 3D dice\n\n## 0.10.2\n- Earlier change\n');
        const manual = { ...options, notes: [] };
        assert.deepEqual(planLocalRelease(root, manual).blockers, []);
        assert.throws(() => planLocalRelease(root, options), /omit --note/);
        await runReleaseCommand(root, { ...manual, noPush: true }, forbiddenIO, line => messages.push(line));
        assert.equal(git('branch', '--show-current'), 'main');
        assert.equal(git('branch', '--format=%(refname:short)'), 'main');
        assert.equal(git('cat-file', '-t', 'v0.11.0'), 'tag');
        assert.equal(git('rev-parse', 'v0.11.0^{}'), git('rev-parse', 'HEAD'));
        assert.equal(git('rev-list', '--count', 'HEAD'), '2');
        assert.equal(git('status', '--porcelain'), '');
        assert.deepEqual(JSON.parse(read('package.json')), { ...pkg, version: '0.11.0' });
        assert.deepEqual(JSON.parse(read('package-lock.json')), { ...lock, version: '0.11.0', packages: { ...lock.packages, '': { ...lock.packages[''], version: '0.11.0' } } });
        assert.ok(messages.join('\n').includes('Prepared v0.11.0 locally'));
        assert.equal(git('remote'), '', 'release succeeds offline without remote operations');

        const cliOutput = execFileSync(process.execPath, [
            path.resolve('node_modules/tsx/dist/cli.mjs'),
            path.resolve('src/scripts/tools/releases/tag-release.ts'),
            '0.11.1', '--note', 'Fixed fixture',
        ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
        assert.ok(cliOutput.includes('git push --no-follow-tags origin main'));
        assert.ok(cliOutput.includes('git push --no-follow-tags origin v0.11.1'));
        assert.ok(!cliOutput.includes('[y/N]'), 'noninteractive CLI stays offline without prompting');
        assert.equal(git('cat-file', '-t', 'v0.11.1'), 'tag');

        fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        const head = git('rev-parse', 'HEAD');
        assert.throws(() => runLocalRelease(root, parseReleaseOptions(['0.11.2', '--note', 'Fixed test fixture']), () => {}), /preparation stopped/);
        assert.equal(git('rev-parse', 'HEAD'), head);
        assert.equal(git('tag', '--list', 'v0.11.2'), '', 'a failed commit must not create a tag');
        assert.equal(JSON.parse(read('package.json')).version, '0.11.2', 'failed work is preserved for inspection');
        console.log('  - local release tagging: all checks passed');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    run().catch(error => { console.error(error); process.exitCode = 1; });
}
