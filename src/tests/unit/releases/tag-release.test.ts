import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseReleaseOptions, planLocalRelease, planResumeRelease, runLocalRelease, runReleaseCommand, type ReleasePublishIO } from '../../../scripts/tools/releases/tag-release';

export async function run() {
    await preparedMetadataRegression();
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

        const block = '\n- Added shared 3D dice\r\n\r\n* Added player settings panel\n';
        const multiline = parseReleaseOptions(['0.11.0', '--notes', block, '--dry-run']);
        assert.deepEqual(multiline.notes, options.notes);
        assert.deepEqual(planLocalRelease(root, multiline).after, planLocalRelease(root, options).after);
        assert.deepEqual(parseReleaseOptions(['0.11.0', '--note', 'First', '--notes', 'Second\n+ Third']).notes, ['First', 'Second', 'Third']);
        const notesFile = path.join('.git', 'release notes.txt');
        fs.writeFileSync(path.join(root, notesFile), block);
        const fromFile = parseReleaseOptions(['0.11.0', '--notes-file', notesFile, '--dry-run']);
        assert.deepEqual(planLocalRelease(root, fromFile).after, planLocalRelease(root, options).after);
        await runReleaseCommand(root, fromFile, forbiddenIO, () => {});
        assert.equal(git('rev-parse', 'HEAD'), initial);
        assert.equal(git('tag'), ''); assert.equal(git('status', '--porcelain'), '');
        assert.deepEqual(['package.json', 'package-lock.json', 'CHANGELOG.md'].map(read), original);
        assert.equal(fs.readFileSync(path.join(root, notesFile), 'utf8'), block, 'notes source stays untouched');
        assert.throws(() => planLocalRelease(root, { ...fromFile, notesFile: 'missing-notes.txt' }), /ENOENT/);
        fs.writeFileSync(path.join(root, notesFile), '## 0.11.0\n- Invalid heading');
        assert.throws(() => planLocalRelease(root, fromFile), /omit headings/);
        fs.writeFileSync(path.join(root, notesFile), ' \n');
        assert.throws(() => planLocalRelease(root, fromFile), /one entry per line/);
        fs.writeFileSync(path.join(root, notesFile), block);

        for (const args of [[], ['nope'], ['0.11.0', '--note'], ['0.11.0', '--note', 'bad\nentry'], ['0.11.0', '--push']]) {
            assert.throws(() => parseReleaseOptions(args));
        }
        assert.equal(parseReleaseOptions(['0.11.0']).tag, 'v0.11.0');
        assert.equal(parseReleaseOptions(['0.11.0', '--no-push']).noPush, true);
        assert.equal(parseReleaseOptions(['0.11.0', '--resume']).resume, true);
        assert.throws(() => parseReleaseOptions(['0.11.0', '--resume', '--note', 'Duplicate notes']), /existing CHANGELOG/);
        assert.throws(() => parseReleaseOptions(['0.11.0', '--reuse-failed-tag']), /requires --resume/);
        for (const flags of [
            ['--notes'], ['--notes', ' \n'], ['--notes', '-'], ['--notes', '- '],
            ['--notes', '## 0.11.0\n- Entry'], ['--notes', '--dry-run'],
            ['--notes-file'], ['--notes-file', '--dry-run'], ['--notes-file', ' '],
            ['--notes-file', 'a', '--notes-file', 'b'],
            ['--notes-file', 'a', '--notes', 'Entry'], ['--note', 'Entry', '--notes-file', 'a'],
        ]) assert.throws(() => parseReleaseOptions(['0.11.0', ...flags]));
        assert.throws(() => planLocalRelease(root, { ...options, tag: 'v0.10.2' }), /omit --note/);
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
        assert.throws(() => planLocalRelease(root, fromFile), /omit --note/);
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
            '0.11.1', '--notes-file', notesFile,
        ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
        assert.ok(cliOutput.includes('git push --no-follow-tags origin main'));
        assert.ok(cliOutput.includes('git push --no-follow-tags origin v0.11.1'));
        assert.ok(!cliOutput.includes('[y/N]'), 'noninteractive CLI stays offline without prompting');
        assert.equal(git('cat-file', '-t', 'v0.11.1'), 'tag');
        assert.ok(read('CHANGELOG.md').includes('## 0.11.1\n- Added shared 3D dice\n- Added player settings panel'));
        const resumed = parseReleaseOptions(['0.11.1', '--resume', '--dry-run']);
        await runReleaseCommand(root, resumed, forbiddenIO, line => messages.push(line));
        assert.ok(messages.some(line => line.includes('Local validation passed')));
        assert.equal(git('rev-parse', 'v0.11.1^{}'), git('rev-parse', 'HEAD'));
        assert.equal(git('status', '--porcelain'), '');
        fs.writeFileSync(path.join(root, 'ci-fix.txt'), 'fixed\n');
        git('add', 'ci-fix.txt'); git('commit', '-m', 'fix ci');
        const staleTag = planResumeRelease(root, resumed);
        assert.equal(staleTag.commit, git('rev-parse', 'HEAD'));
        assert.notEqual(staleTag.taggedCommit, staleTag.commit);
        await runReleaseCommand(root, resumed, forbiddenIO, line => messages.push(line));
        assert.ok(messages.some(line => line.includes('remote recovery checks')));
        assert.equal(git('rev-parse', 'v0.11.1^{}'), staleTag.taggedCommit, 'resume dry-run never moves a tag');

        fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        const head = git('rev-parse', 'HEAD');
        assert.throws(() => runLocalRelease(root, parseReleaseOptions(['0.11.2', '--note', 'Fixed test fixture']), () => {}), /preparation stopped/);
        assert.equal(git('rev-parse', 'HEAD'), head);
        assert.equal(git('tag', '--list', 'v0.11.2'), '', 'a failed commit must not create a tag');
        assert.equal(JSON.parse(read('package.json')).version, '0.11.2', 'failed work is preserved for inspection');
        console.log('  - local release tagging: all checks passed');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/** Metadata may have been bumped/merged before the release helper is invoked. */
async function preparedMetadataRegression() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-prebumped-release-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const options = parseReleaseOptions(['0.18.1', '--dry-run']);
    const releaseFiles = ['package.json', 'package-lock.json', 'CHANGELOG.md'];
    const snapshot = () => releaseFiles.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
    const io: ReleasePublishIO = { command: () => { throw new Error('Dry run contacted a remote'); },
        confirm: async () => { throw new Error('Dry run prompted'); }, sleep: async () => {}, now: () => 0 };
    try {
        git('init', '-b', 'main');
        git('config', 'user.name', 'Release Test'); git('config', 'user.email', 'release@example.invalid');
        git('config', 'commit.gpgsign', 'false'); git('config', 'tag.gpgsign', 'false');
        git('config', 'core.hooksPath', path.join(root, '.git', 'hooks'));
        fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "fixture", "version": "0.18.1" }\n');
        fs.writeFileSync(path.join(root, 'package-lock.json'), '{ "version": "0.18.1", "packages": { "": { "version": "0.18.1" } } }\n');
        fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Releases\n## 0.18.1\n- Prepared metadata\n');
        git('add', '.'); git('commit', '-m', 'merged version bump');
        const before = snapshot(), head = git('rev-parse', 'HEAD');
        const messages: string[] = [];
        assert.equal(planLocalRelease(root, options).tagOnly, true);
        for (const resume of [false, true]) {
            await runReleaseCommand(root, { ...options, resume }, io, line => messages.push(line));
            assert.equal(git('tag'), '');
            assert.equal(git('status', '--porcelain'), '');
            assert.equal(git('rev-parse', 'HEAD'), head);
            assert.deepEqual(snapshot(), before, 'tag-only previews preserve exact metadata bytes');
        }
        assert.ok(messages.some(line => /no (new )?release commit/i.test(line)));
        assert.throws(() => planLocalRelease(root, { ...options, notes: ['Do not replace notes'] }), /omit.*note/i);
        assert.throws(() => planLocalRelease(root, { ...options, notesFile: 'ignored.txt' }), /omit.*note/i);
        fs.writeFileSync(path.join(root, 'package-lock.json'), '{ "version": "0.18.0" }');
        assert.throws(() => planLocalRelease(root, options), /must match/);
        fs.writeFileSync(path.join(root, 'package-lock.json'), before[1]);
        fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Releases\n');
        assert.throws(() => planLocalRelease(root, options), /missing the exact heading/);
        fs.writeFileSync(path.join(root, 'CHANGELOG.md'), before[2]);
        fs.appendFileSync(path.join(root, 'CHANGELOG.md'), '- Uncommitted note\n');
        assert.throws(() => runLocalRelease(root, options, () => {}), /clean worktree/);
        assert.throws(() => planResumeRelease(root, { ...options, resume: true }), /clean worktree/);
        fs.writeFileSync(path.join(root, 'CHANGELOG.md'), before[2]);
        fs.writeFileSync(path.join(root, 'unrelated.txt'), 'keep');
        assert.throws(() => runLocalRelease(root, options, () => {}), /clean worktree/);
        fs.unlinkSync(path.join(root, 'unrelated.txt'));
        fs.writeFileSync(path.join(root, '.git', 'MERGE_HEAD'), head);
        assert.throws(() => runLocalRelease(root, options, () => {}), /in-progress/);
        fs.unlinkSync(path.join(root, '.git', 'MERGE_HEAD'));
        let raced = false;
        assert.throws(() => runLocalRelease(root, { ...options, dryRun: false }, () => {
            if (!raced) { raced = true; fs.writeFileSync(path.join(root, 'raced.txt'), 'preserve'); }
        }), /state changed/);
        assert.equal(git('tag'), '', 'state changes after displaying the plan must not create a tag');
        fs.unlinkSync(path.join(root, 'raced.txt'));
        // A failing commit hook proves recovery does not try to create an empty commit.
        fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        const commands: string[][] = [];
        const resumeIO: ReleasePublishIO = { ...io, command: (program, args) => {
            if (program === 'gh') {
                if (args[0] === 'release') throw new Error('HTTP 404 release not found');
                if (args[0] === 'run') return JSON.stringify([{ databaseId: 1, headSha: head, headBranch: 'main',
                    event: 'push', status: 'completed', conclusion: 'success', url: 'https://example.invalid/run/1' }]);
                return 'fixture';
            }
            commands.push(args);
            if (args[0] === 'remote') return 'git@github.com:fixture/release.git';
            if (args[0] === 'ls-remote') return args.at(-1) === 'refs/heads/main' ? `${head}\trefs/heads/main` : '';
            assert.notEqual(args[0], 'push', 'no-push resume cannot publish');
            return git(...args);
        } };
        await runReleaseCommand(root, { ...options, resume: true, dryRun: false, noPush: true }, resumeIO, line => messages.push(line));
        assert.equal(git('rev-parse', 'v0.18.1^{}'), head);
        assert.equal(git('rev-list', '--count', 'HEAD'), '1');
        assert.deepEqual(snapshot(), before);
        assert.equal(git('status', '--porcelain'), '');
        assert.equal(commands.filter(args => ['add', 'commit', 'push'].includes(args[0])).length, 0);
        git('tag', '-d', 'v0.18.1'); // Fixture-only reset to exercise the non-resume path as well.
        const release = runLocalRelease(root, { ...options, dryRun: false, noPush: true }, line => messages.push(line));
        assert.equal(release?.commit, head);
        assert.equal(git('rev-list', '--count', 'HEAD'), '1');
        assert.equal(git('cat-file', '-t', 'refs/tags/v0.18.1'), 'tag');
        assert.equal(git('rev-parse', 'v0.18.1^{}'), head);
        assert.deepEqual(snapshot(), before);
        assert.equal(git('status', '--porcelain'), '');
        assert.throws(() => runLocalRelease(root, options, () => {}), /already exists/);
        assert.throws(() => planLocalRelease(root, { ...options, tag: 'v0.18.0' }), /must be newer/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    run().catch(error => { console.error(error); process.exitCode = 1; });
}
