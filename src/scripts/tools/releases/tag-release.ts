import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { prepareRelease, versionFromReleaseTag } from './prepare-release';

const releaseFiles = ['package.json', 'package-lock.json', 'CHANGELOG.md'] as const;
const usage = 'npm run release:tag -- <VERSION|vVERSION> [--note "Short changelog entry"]... [--dry-run]';

export interface ReleaseOptions { tag: string; notes: string[]; dryRun: boolean }

export function parseReleaseOptions(args: string[]): ReleaseOptions {
    const [version, ...flags] = args;
    if (!version || version.startsWith('-')) throw new Error(`Usage: ${usage}`);
    const tag = version.startsWith('v') ? version : `v${version}`;
    versionFromReleaseTag(tag);
    const options: ReleaseOptions = { tag, notes: [], dryRun: false };
    for (let i = 0; i < flags.length; i++) {
        if (flags[i] === '--dry-run') options.dryRun = true;
        else if (flags[i] === '--note') {
            const note = flags[++i]?.trim();
            if (!note || note.startsWith('-') || /[\r\n]/.test(note)) {
                throw new Error('--note requires one non-empty, single-line entry (without a bullet prefix).');
            }
            options.notes.push(note);
        } else throw new Error(`Unknown option: ${flags[i]}. Usage: ${usage}`);
    }
    return options;
}

function git(root: string, args: string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function newerVersion(next: string, current: string): boolean {
    const left = next.split('.').map(BigInt), right = current.split('.').map(BigInt);
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
    return false;
}

export function planLocalRelease(root: string, options: ReleaseOptions) {
    const version = versionFromReleaseTag(options.tag);
    const before = Object.fromEntries(releaseFiles.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
    const pkg = JSON.parse(before['package.json']);
    const lock = JSON.parse(before['package-lock.json']);
    if (typeof pkg.version !== 'string') throw new Error('package.json must have a release version.');
    versionFromReleaseTag(`v${pkg.version}`);
    if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
        throw new Error('package.json and both root package-lock.json versions must match before releasing.');
    }
    if (!newerVersion(version, pkg.version)) throw new Error(`Version ${version} must be newer than ${pkg.version}.`);

    const branch = git(root, ['branch', '--show-current']);
    const blockers: string[] = [];
    if (branch !== 'main') blockers.push('Check out main after merging the feature; this command never changes branches.');
    if (git(root, ['tag', '--list', options.tag])) blockers.push(`Tag ${options.tag} already exists; tags are never replaced.`);
    const dirty = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    // A hand-written release entry is allowed, but no other staged or unstaged work is swept into the commit.
    if (dirty.split('\0').filter(Boolean).some(entry => !/^ M CHANGELOG\.md$|^M  CHANGELOG\.md$|^MM CHANGELOG\.md$/.test(entry))) {
        blockers.push('Commit or move unrelated work first; only CHANGELOG.md may have uncommitted edits.');
    }
    for (const file of releaseFiles) {
        if (!git(root, ['ls-files', '--', file])) blockers.push(`${file} must already be tracked.`);
    }
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
        const markerPath = git(root, ['rev-parse', '--git-path', marker]);
        if (fs.existsSync(path.resolve(root, markerPath))) blockers.push(`Finish the in-progress Git operation (${marker}) first.`);
    }

    const eol = before['CHANGELOG.md'].includes('\r\n') ? '\r\n' : '\n';
    let changelog = before['CHANGELOG.md'];
    if (options.notes.length) {
        if (changelog.split(/\r?\n/).some(line => line.trim() === `## ${version}`)) {
            throw new Error(`CHANGELOG.md already contains ${version}; omit --note to use that section.`);
        }
        const heading = changelog.match(/^# .*(?:\r?\n|$)/);
        if (!heading) throw new Error('CHANGELOG.md must begin with its release title.');
        changelog = heading[0].trimEnd() + eol + `## ${version}` + eol
            + options.notes.map(note => `- ${note}`).join(eol) + eol + eol
            + changelog.slice(heading[0].length);
    }
    const { notes } = prepareRelease(options.tag, version, changelog);
    const oldVersion = pkg.version;
    pkg.version = version;
    lock.version = version;
    lock.packages[''].version = version;
    const json = (value: unknown, original: string) => JSON.stringify(value, null, 2).replace(/\n/g, original.includes('\r\n') ? '\r\n' : '\n')
        + (original.includes('\r\n') ? '\r\n' : '\n');
    const after: Record<string, string> = {
        'package.json': json(pkg, before['package.json']),
        'package-lock.json': json(lock, before['package-lock.json']),
        'CHANGELOG.md': changelog,
    };
    return { tag: options.tag, oldVersion, version, notes, before, after, blockers };
}

export function runLocalRelease(root: string, options: ReleaseOptions, output: (line: string) => void = console.log): void {
    const plan = planLocalRelease(root, options);
    output(`${options.dryRun ? 'DRY RUN' : 'Release plan'}: ${plan.tag} on main`);
    output(`package.json version: ${plan.oldVersion} -> ${plan.version}`);
    output(`package-lock.json version and packages[""].version: ${plan.oldVersion} -> ${plan.version}`);
    output(`CHANGELOG.md:\n## ${plan.version}\n${plan.notes}`);
    output(`Commit: chore(release): prepare ${plan.tag}\nAnnotated tag: ${plan.tag} (SheetDelver ${plan.tag})`);
    output('No branch creation, remote operations, SDK version changes, or dependency updates.');
    if (plan.blockers.length) throw new Error(plan.blockers.join('\n'));
    if (options.dryRun) {
        output('Validation passed. No files, commits, or tags changed. Repeat without --dry-run to prepare.');
        return;
    }

    // No automatic reset/rollback: a failed hook or signing operation leaves inspectable local work, never a misleading tag.
    for (const file of releaseFiles) fs.writeFileSync(path.join(root, file), plan.after[file]);
    try {
        git(root, ['add', '--', ...releaseFiles]);
        output(git(root, ['commit', '-m', `chore(release): prepare ${plan.tag}`]));
        const committed = git(root, ['rev-parse', 'HEAD']);
        for (const file of releaseFiles) {
            const content = execFileSync('git', ['show', `${committed}:${file}`], { cwd: root, encoding: 'utf8' });
            if (content !== plan.after[file]) throw new Error(`Committed ${file} differs from the release plan; no tag created.`);
        }
        if (git(root, ['status', '--porcelain'])) throw new Error('Worktree changed during commit; no tag created.');
        git(root, ['tag', '-a', plan.tag, '-m', `SheetDelver ${plan.tag}`, committed]);
    } catch (error) {
        throw new Error('Release preparation stopped. Inspect git status/log before retrying; no push or automatic rollback was performed.', { cause: error });
    }
    output(`Prepared ${plan.tag} locally. Push the commit, wait for main CI, then push only this tag:\ngit push origin main\ngit push origin ${plan.tag}`);
    output('The tag push triggers the release workflow. Nothing has been pushed by this command.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        if (process.argv.slice(2).includes('--help')) console.log(usage);
        else runLocalRelease(process.cwd(), parseReleaseOptions(process.argv.slice(2)));
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
}
