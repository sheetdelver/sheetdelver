import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { prepareRelease, versionFromReleaseTag } from './prepare-release';

const releaseFiles = ['package.json', 'package-lock.json', 'CHANGELOG.md'] as const;
const usage = 'npm run release:tag -- <VERSION|vVERSION> [--note "Short changelog entry"]... [--dry-run] [--no-push]';

export interface ReleaseOptions { tag: string; notes: string[]; dryRun: boolean; noPush: boolean }

export function parseReleaseOptions(args: string[]): ReleaseOptions {
    const [version, ...flags] = args;
    if (!version || version.startsWith('-')) throw new Error(`Usage: ${usage}`);
    const tag = version.startsWith('v') ? version : `v${version}`;
    versionFromReleaseTag(tag);
    const options: ReleaseOptions = { tag, notes: [], dryRun: false, noPush: false };
    for (let i = 0; i < flags.length; i++) {
        if (flags[i] === '--dry-run') options.dryRun = true;
        else if (flags[i] === '--no-push') options.noPush = true;
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

export function runLocalRelease(root: string, options: ReleaseOptions, output: (line: string) => void = console.log): LocalRelease | undefined {
    const plan = planLocalRelease(root, options);
    output(`${options.dryRun ? 'DRY RUN' : 'Release plan'}: ${plan.tag} on main`);
    output(`package.json version: ${plan.oldVersion} -> ${plan.version}`);
    output(`package-lock.json version and packages[""].version: ${plan.oldVersion} -> ${plan.version}`);
    output(`CHANGELOG.md:\n## ${plan.version}\n${plan.notes}`);
    output(`Commit: chore(release): prepare ${plan.tag}\nAnnotated tag: ${plan.tag} (SheetDelver ${plan.tag})`);
    output('Local preparation creates no branch and performs no remote operations, SDK version changes, or dependency updates.');
    if (plan.blockers.length) throw new Error(plan.blockers.join('\n'));
    if (options.dryRun) {
        output('Validation passed. No files, commits, tags, prompts, or remote operations. Repeat without --dry-run to prepare.');
        return;
    }

    // No automatic reset/rollback: a failed hook or signing operation leaves inspectable local work, never a misleading tag.
    for (const file of releaseFiles) fs.writeFileSync(path.join(root, file), plan.after[file]);
    let committed: string;
    try {
        git(root, ['add', '--', ...releaseFiles]);
        output(git(root, ['commit', '-m', `chore(release): prepare ${plan.tag}`]));
        committed = git(root, ['rev-parse', 'HEAD']);
        for (const file of releaseFiles) {
            const content = execFileSync('git', ['show', `${committed}:${file}`], { cwd: root, encoding: 'utf8' });
            if (content !== plan.after[file]) throw new Error(`Committed ${file} differs from the release plan; no tag created.`);
        }
        if (git(root, ['status', '--porcelain'])) throw new Error('Worktree changed during commit; no tag created.');
        git(root, ['tag', '-a', plan.tag, '-m', `SheetDelver ${plan.tag}`, committed]);
    } catch (error) {
        throw new Error('Release preparation stopped. Inspect git status/log before retrying; no push or automatic rollback was performed.', { cause: error });
    }
    output(`Prepared ${plan.tag} locally at ${committed}. Nothing has been pushed yet.`);
    return { tag: plan.tag, commit: committed };
}

export interface LocalRelease { tag: string; commit: string }
export interface ReleasePublishIO {
    confirm(question: string): Promise<boolean>;
    command(program: 'git' | 'gh', args: string[]): string;
    sleep(ms: number): Promise<void>;
    now(): number;
}

export function acceptsPush(answer: string): boolean {
    return /^(y|yes)$/i.test(answer.trim());
}

function consolePublishIO(root: string): ReleasePublishIO {
    return {
        confirm: async question => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const abort = new AbortController();
            rl.on('close', () => abort.abort());
            rl.on('SIGINT', () => rl.close());
            try { return acceptsPush(await rl.question(question + ' [y/N] ', { signal: abort.signal })); }
            catch (error) { throw new Error('Publishing cancelled. Local release preparation is preserved.', { cause: error }); }
            finally { rl.close(); }
        },
        command: (program, args) => {
            const pushing = program === 'git' && args[0] === 'push';
            const result = execFileSync(program, args, {
                cwd: root, encoding: 'utf8', timeout: pushing ? 120_000 : 30_000,
                stdio: pushing ? 'inherit' : ['ignore', 'pipe', 'pipe'],
            });
            return result?.trim() ?? '';
        },
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        now: () => Date.now(),
    };
}

/** Pin GitHub status queries to origin's push repository, not gh's inferred default. */
export function releaseRepository(remote: string): string {
    const url = new URL(remote.replace(/^([^@/]+)@([^:]+):/, 'ssh://$1@$2/'));
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/');
    if (!['https:', 'ssh:'].includes(url.protocol) || parts.length !== 2
        || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part))
        || url.password || (url.protocol === 'https:' && url.username) || url.search || url.hash) {
        throw new Error('origin must have a single GitHub HTTPS or SSH push URL; publish manually otherwise.');
    }
    return url.hostname + '/' + parts.join('/');
}

interface WorkflowRun {
    databaseId: number; headSha: string; headBranch: string; event: string;
    status: string; conclusion: string | null; url: string;
}

export async function waitForReleaseWorkflow(
    io: ReleasePublishIO, repo: string, workflow: string, branch: string, commit: string,
    output: (line: string) => void, timeoutMs = 30 * 60_000,
): Promise<void> {
    const deadline = io.now() + timeoutMs;
    output(`Waiting for ${workflow} on ${branch} at ${commit} (up to 30 minutes)...`);
    while (io.now() < deadline) {
        const result: unknown = JSON.parse(io.command('gh', [
            'run', 'list', '--repo', repo, '--workflow', workflow,
            '--branch', branch, '--event', 'push', '--commit', commit, '--limit', '20',
            '--json', 'databaseId,headSha,headBranch,event,status,conclusion,url',
        ]));
        if (!Array.isArray(result)) throw new Error('GitHub returned an invalid workflow list.');
        const run = (result as WorkflowRun[]).filter(run => run && run.headSha === commit
            && run.headBranch === branch && run.event === 'push' && Number.isSafeInteger(run.databaseId))
            .sort((a, b) => b.databaseId - a.databaseId)[0];
        output(run ? `${workflow}: ${run.status} (${run.url})` : `${workflow}: waiting for GitHub to register the push...`);
        if (run?.status === 'completed') {
            if (run.conclusion !== 'success') throw new Error(`${workflow} ended with ${run.conclusion || 'no result'}: ${run.url}`);
            output(`${workflow} passed for ${commit}.`);
            return;
        }
        await io.sleep(Math.min(10_000, Math.max(0, deadline - io.now())));
    }
    throw new Error(`Timed out waiting for ${workflow} at ${commit}. Verify CI manually before proceeding.`);
}

function remainingSteps(release: LocalRelease, mainPushed: boolean, ciPassed: boolean, tagPushed: boolean, output: (line: string) => void) {
    output(`Prepared ${release.tag}: main ${mainPushed ? 'push confirmed' : 'push not confirmed'}; tag ${tagPushed ? 'push confirmed' : 'push not confirmed'}.`);
    if (tagPushed) {
        output('The tag is published. Inspect the release workflow if it did not complete; do not move or replace the tag.');
        return;
    }
    output('Remaining manual steps:');
    if (!mainPushed) output('git push --no-follow-tags origin main');
    if (!ciPassed) output(`Wait for successful main CI for commit ${release.commit} before pushing the tag.`);
    output(`git push --no-follow-tags origin ${release.tag}`);
}

export async function publishLocalRelease(release: LocalRelease, io: ReleasePublishIO | undefined, output: (line: string) => void = console.log) {
    let mainPushed = false, ciPassed = false, tagPushed = false, releasePassed = false;
    try {
        if (!io || !await io.confirm('Push the prepared main commit to origin?')) return;
        const pushUrl = io.command('git', ['remote', 'get-url', '--push', '--all', 'origin']);
        if (!pushUrl || pushUrl.split(/\r?\n/).length !== 1) throw new Error('origin must have exactly one push URL.');
        const repo = releaseRepository(pushUrl);
        // Validate gh availability before attempting a push. Authentication/API errors still fail closed.
        io.command('gh', ['--version']);
        const verifyRefs = () => {
            if (io.command('git', ['rev-parse', 'refs/heads/main']) !== release.commit
                || io.command('git', ['rev-parse', `refs/tags/${release.tag}^{commit}`]) !== release.commit
                || io.command('git', ['remote', 'get-url', '--push', '--all', 'origin']) !== pushUrl) {
                throw new Error('Prepared refs or origin changed during publishing. Inspect them before continuing.');
            }
        };
        verifyRefs();
        output('Pushing main without tags...');
        output(io.command('git', ['push', '--no-follow-tags', 'origin', 'refs/heads/main:refs/heads/main']));
        mainPushed = true;
        await waitForReleaseWorkflow(io, repo, 'ci.yml', 'main', release.commit, output);
        ciPassed = true;
        if (!await io.confirm(`Main CI passed. Push tag ${release.tag} to origin and start the release?`)) return;
        verifyRefs();
        output(`Pushing only ${release.tag}...`);
        output(io.command('git', ['push', '--no-follow-tags', 'origin', `refs/tags/${release.tag}:refs/tags/${release.tag}`]));
        tagPushed = true;
        await waitForReleaseWorkflow(io, repo, 'release.yml', release.tag, release.commit, output);
        releasePassed = true;
        output(`Published ${release.tag}; main CI and release workflow both passed.`);
    } finally {
        if (!releasePassed) remainingSteps(release, mainPushed, ciPassed, tagPushed, output);
    }
}

export async function runReleaseCommand(root: string, options: ReleaseOptions, io: ReleasePublishIO | undefined, output: (line: string) => void = console.log) {
    const release = runLocalRelease(root, options, output);
    if (release) await publishLocalRelease(release, options.noPush ? undefined : io, output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        if (process.argv.slice(2).includes('--help')) console.log(usage);
        else {
            const options = parseReleaseOptions(process.argv.slice(2));
            const io = !options.dryRun && !options.noPush && process.stdin.isTTY && process.stdout.isTTY
                ? consolePublishIO(process.cwd()) : undefined;
            await runReleaseCommand(process.cwd(), options, io);
        }
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
}
