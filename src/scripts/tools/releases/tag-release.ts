import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { prepareRelease, versionFromReleaseTag } from './prepare-release';

const releaseFiles = ['package.json', 'package-lock.json', 'CHANGELOG.md'] as const;
const usage = 'npm run release:tag -- <VERSION|vVERSION> [--note "Entry"]... [--notes "Multiline entries" | --notes-file PATH] [--dry-run] [--no-push] [--resume [--reuse-failed-tag]]';

export interface ReleaseOptions { tag: string; notes: string[]; notesFile?: string; dryRun: boolean; noPush: boolean; resume: boolean; reuseFailedTag: boolean }

function parseMultilineNotes(text: string): string[] {
    const lines = text.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean);
    const notes = lines.map(line => line.replace(/^[-*+]\s+/, '').trim());
    if (!notes.length || notes.some(note => !note || /^[-*+#]/.test(note))) {
        throw new Error('Release notes require one entry per line, optionally prefixed with - , * or +; omit headings and empty bullets.');
    }
    return notes;
}

export function parseReleaseOptions(args: string[]): ReleaseOptions {
    const [version, ...flags] = args;
    if (!version || version.startsWith('-')) throw new Error(`Usage: ${usage}`);
    const tag = version.startsWith('v') ? version : `v${version}`;
    versionFromReleaseTag(tag);
    const options: ReleaseOptions = { tag, notes: [], dryRun: false, noPush: false, resume: false, reuseFailedTag: false };
    for (let i = 0; i < flags.length; i++) {
        if (flags[i] === '--dry-run') options.dryRun = true;
        else if (flags[i] === '--no-push') options.noPush = true;
        else if (flags[i] === '--resume') options.resume = true;
        else if (flags[i] === '--reuse-failed-tag') options.reuseFailedTag = true;
        else if (flags[i] === '--note') {
            const note = flags[++i]?.trim();
            if (!note || note.startsWith('-') || /[\r\n]/.test(note)) {
                throw new Error('--note requires one non-empty, single-line entry (without a bullet prefix).');
            }
            options.notes.push(note);
        } else if (flags[i] === '--notes') {
            const text = flags[++i];
            if (!text) throw new Error('--notes requires a non-empty multiline block.');
            options.notes.push(...parseMultilineNotes(text));
        } else if (flags[i] === '--notes-file') {
            const file = flags[++i];
            if (!file?.trim() || file.startsWith('-')) throw new Error('--notes-file requires a file path.');
            if (options.notesFile) throw new Error('Use only one --notes-file.');
            options.notesFile = file;
        } else throw new Error(`Unknown option: ${flags[i]}. Usage: ${usage}`);
    }
    if (options.notesFile && options.notes.length) throw new Error('Use --notes-file without --note or --notes.');
    if (options.resume && (options.notesFile || options.notes.length)) throw new Error('--resume uses the existing CHANGELOG.md section; omit note flags.');
    if (options.reuseFailedTag && !options.resume) throw new Error('--reuse-failed-tag requires --resume.');
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
    const entries = options.notesFile
        ? parseMultilineNotes(fs.readFileSync(path.resolve(root, options.notesFile), 'utf8')) : options.notes;
    if (entries.length) {
        if (changelog.split(/\r?\n/).some(line => line.trim() === `## ${version}`)) {
            throw new Error(`CHANGELOG.md already contains ${version}; omit --note, --notes and --notes-file to use that section.`);
        }
        const heading = changelog.match(/^# .*(?:\r?\n|$)/);
        if (!heading) throw new Error('CHANGELOG.md must begin with its release title.');
        changelog = heading[0].trimEnd() + eol + `## ${version}` + eol
            + entries.map(note => `- ${note}`).join(eol) + eol + eol
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

/** Resume an already prepared version without creating another release commit. */
export function planResumeRelease(root: string, options: ReleaseOptions): LocalRelease & { taggedCommit: string } {
    const version = versionFromReleaseTag(options.tag);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    if (pkg.version !== version || lock.version !== version || lock.packages?.['']?.version !== version) {
        throw new Error(`Resume requires package.json and both root lockfile versions to equal ${version}.`);
    }
    prepareRelease(options.tag, version, fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'));
    if (git(root, ['branch', '--show-current']) !== 'main') throw new Error('Resume requires main.');
    if (git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('Resume requires a clean worktree.');
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
        const markerPath = git(root, ['rev-parse', '--git-path', marker]);
        if (fs.existsSync(path.resolve(root, markerPath))) throw new Error(`Finish the in-progress Git operation (${marker}) first.`);
    }
    if (!git(root, ['tag', '--list', options.tag])) throw new Error(`Local tag ${options.tag} is missing; prepare the release first.`);
    if (git(root, ['cat-file', '-t', `refs/tags/${options.tag}`]) !== 'tag') {
        throw new Error(`Local tag ${options.tag} must be annotated.`);
    }
    const commit = git(root, ['rev-parse', 'HEAD']);
    const taggedCommit = git(root, ['rev-parse', `refs/tags/${options.tag}^{commit}`]);
    try { git(root, ['merge-base', '--is-ancestor', taggedCommit, commit]); }
    catch { throw new Error(`Local tag ${options.tag} is not an ancestor of main; refusing to move it.`); }
    return { tag: options.tag, commit, taggedCommit };
}

export interface ReleasePublishIO {
    confirm(question: string): Promise<boolean>;
    command(program: 'git' | 'gh', args: string[]): string;
    sleep(ms: number): Promise<void>;
    now(): number;
}

function remoteRef(io: ReleasePublishIO, pushUrl: string, kind: 'heads' | 'tags', name: string): string | undefined {
    const ref = `refs/${kind}/${name}`;
    const lines = io.command('git', ['ls-remote', `--${kind}`, pushUrl, ref]).trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return;
    if (lines.length !== 1) throw new Error(`origin returned multiple matches for ${ref}.`);
    const match = /^([0-9a-f]{40})\t(.+)$/.exec(lines[0]);
    if (!match || match[2] !== ref) throw new Error(`origin returned an unexpected reference for ${ref}.`);
    return match[1];
}

/** Re-read remote refs on every invocation, including after an uncertain push result. */
export async function resumeLocalRelease(
    release: LocalRelease & { taggedCommit: string }, io: ReleasePublishIO, allowPush: boolean,
    output: (line: string) => void = console.log, reuseFailedTag = false,
): Promise<void> {
    const pushUrl = io.command('git', ['remote', 'get-url', '--push', '--all', 'origin']);
    if (!pushUrl || pushUrl.split(/\r?\n/).length !== 1) throw new Error('origin must have exactly one push URL.');
    const repo = releaseRepository(pushUrl);
    io.command('gh', ['--version']);
    let remoteMain = remoteRef(io, pushUrl, 'heads', 'main');
    if (!remoteMain) throw new Error('origin/main is missing.');
    let remoteTag = remoteRef(io, pushUrl, 'tags', release.tag);
    let localTag = io.command('git', ['rev-parse', `refs/tags/${release.tag}`]);
    if (remoteTag && remoteTag !== localTag) {
        throw new Error(`${release.tag} already exists on origin at a different tag object; never replace a published tag. Prepare a new version.`);
    }
    if (!remoteTag && githubReleaseExists(io, repo, release.tag)) {
        throw new Error(`GitHub Release ${release.tag} exists even though its remote tag is absent; refusing to reuse it.`);
    }
    const moveLocalTag = () => {
        output(`Moving local ${release.tag} from ${release.taggedCommit} to ${release.commit}...`);
        io.command('git', ['tag', '-f', '-a', release.tag, '-m', `SheetDelver ${release.tag}`, release.commit]);
        localTag = io.command('git', ['rev-parse', `refs/tags/${release.tag}`]);
    };
    const verifyLocal = () => {
        if (io.command('git', ['rev-parse', 'refs/heads/main']) !== release.commit
            || io.command('git', ['rev-parse', `refs/tags/${release.tag}`]) !== localTag
            || io.command('git', ['remote', 'get-url', '--push', '--all', 'origin']) !== pushUrl) {
            throw new Error('Prepared refs or origin changed during resume. Inspect before continuing.');
        }
    };
    verifyLocal();
    const ensureMainReady = async (): Promise<boolean> => {
        if (remoteMain !== release.commit) {
            let ancestor = false;
            try { io.command('git', ['merge-base', '--is-ancestor', remoteMain!, release.commit]); ancestor = true; }
            catch { /* A non-fast-forward remote must never be pushed. */ }
            if (!ancestor) throw new Error('origin/main is not an ancestor of local main. Synchronize and inspect before resuming.');
            if (!allowPush || !await io.confirm('Push the current main commit to origin?')) {
                output('Main is not pushed. Resume again after pushing main.');
                return false;
            }
            verifyLocal();
            output('Pushing main without tags...');
            io.command('git', ['push', '--no-follow-tags', 'origin', 'refs/heads/main:refs/heads/main']);
            remoteMain = release.commit;
        } else output('Current main commit is already on origin.');
        await waitOrOfferRerun(io, repo, 'ci.yml', 'main', release.commit, allowPush, output);
        return true;
    };
    if (remoteTag && release.taggedCommit === release.commit) {
        output(`${release.tag} is already on origin; checking its release workflow without pushing it again.`);
        await waitOrOfferRerun(io, repo, 'release.yml', release.tag, release.commit, allowPush, output);
        output(`Release workflow passed for ${release.tag}.`);
        return;
    }
    if (remoteTag && release.taggedCommit !== release.commit) {
        if (!reuseFailedTag) {
            throw new Error(`${release.tag} is published at an older commit. Use --reuse-failed-tag only after fixing the source and reviewing the failed release run.`);
        }
        assertFailedTagCanBeReused(io, repo, release.tag, release.taggedCommit);
        if (!await ensureMainReady()) return;
        if (!allowPush) {
            output('Remote tag recovery requires an interactive confirmation; no remote tag was deleted.');
            return;
        }
        if (!await io.confirm(`Delete failed remote tag ${release.tag} and reuse this version? Existing tag consumers may be disrupted.`)) return;
        verifyLocal();
        if (remoteRef(io, pushUrl, 'tags', release.tag) !== remoteTag || remoteRef(io, pushUrl, 'heads', 'main') !== release.commit) {
            throw new Error('Remote refs changed before tag recovery; inspect before continuing.');
        }
        assertFailedTagCanBeReused(io, repo, release.tag, release.taggedCommit);
        output(`Deleting failed remote tag ${release.tag}...`);
        io.command('git', ['push', '--no-follow-tags', 'origin', `:refs/tags/${release.tag}`]);
        if (remoteRef(io, pushUrl, 'tags', release.tag)) throw new Error('Remote tag still exists after deletion attempt; inspect before continuing.');
        remoteTag = undefined;
        moveLocalTag();
    } else {
        if (release.taggedCommit !== release.commit) moveLocalTag();
        if (!await ensureMainReady()) return;
    }
    if (!allowPush || !await io.confirm(`Main CI passed. Push tag ${release.tag} to origin and start the release?`)) {
        output(`Tag remains local. Resume later with: npm run release:tag -- ${release.tag} --resume`);
        return;
    }
    verifyLocal();
    if (remoteRef(io, pushUrl, 'tags', release.tag)) throw new Error(`${release.tag} appeared on origin during resume; inspect it before pushing.`);
    if (remoteRef(io, pushUrl, 'heads', 'main') !== release.commit) throw new Error('origin/main changed during resume; inspect it before pushing the tag.');
    output(`Pushing only ${release.tag}...`);
    io.command('git', ['push', '--no-follow-tags', 'origin', `refs/tags/${release.tag}:refs/tags/${release.tag}`]);
    await waitOrOfferRerun(io, repo, 'release.yml', release.tag, release.commit, allowPush, output);
    output(`Published ${release.tag}; main CI and release workflow both passed.`);
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
    status: string; conclusion: string | null; url: string; attempt?: number;
}

function latestWorkflowRun(io: ReleasePublishIO, repo: string, workflow: string, branch: string, commit: string): WorkflowRun | undefined {
    const result: unknown = JSON.parse(io.command('gh', [
        'run', 'list', '--repo', repo, '--workflow', workflow,
        '--branch', branch, '--event', 'push', '--commit', commit, '--limit', '20',
        '--json', 'databaseId,headSha,headBranch,event,status,conclusion,url,attempt',
    ]));
    if (!Array.isArray(result)) throw new Error('GitHub returned an invalid workflow list.');
    return (result as WorkflowRun[]).filter(run => run && run.headSha === commit
        && run.headBranch === branch && run.event === 'push' && Number.isSafeInteger(run.databaseId))
        .sort((a, b) => b.databaseId - a.databaseId)[0];
}

function githubReleaseExists(io: ReleasePublishIO, repo: string, tag: string): boolean {
    try {
        io.command('gh', ['release', 'view', tag, '--repo', repo, '--json', 'tagName']);
        return true;
    } catch (error) {
        const details = error instanceof Error ? `${error.message} ${String((error as Error & { stderr?: unknown }).stderr ?? '')}` : String(error);
        if (/release not found|HTTP 404/i.test(details)) return false;
        throw new Error(`Could not verify whether a GitHub Release exists for ${tag}; refusing tag recovery.`, { cause: error });
    }
}

function assertFailedTagCanBeReused(io: ReleasePublishIO, repo: string, tag: string, taggedCommit: string): void {
    if (githubReleaseExists(io, repo, tag)) throw new Error(`GitHub Release ${tag} exists; its tag must not be reused.`);
    const run = latestWorkflowRun(io, repo, 'release.yml', tag, taggedCommit);
    if (!run || run.status !== 'completed' || !['failure', 'cancelled', 'timed_out'].includes(run.conclusion ?? '')) {
        throw new Error(`No completed failed release workflow was found for ${tag} at ${taggedCommit}; refusing tag recovery.`);
    }
}

async function waitOrOfferRerun(
    io: ReleasePublishIO, repo: string, workflow: string, branch: string, commit: string,
    allowWrite: boolean, output: (line: string) => void,
): Promise<void> {
    try { await waitForReleaseWorkflow(io, repo, workflow, branch, commit, output); }
    catch (error) {
        const run = latestWorkflowRun(io, repo, workflow, branch, commit);
        if (!run || run.status !== 'completed' || !['failure', 'cancelled', 'timed_out'].includes(run.conclusion ?? '')) throw error;
        if (workflow === 'release.yml' && githubReleaseExists(io, repo, branch)) throw error;
        if (!allowWrite || !await io.confirm(`${workflow} failed at ${run.url}. Rerun the same workflow once?`)) throw error;
        io.command('gh', ['run', 'rerun', String(run.databaseId), '--repo', repo]);
        await waitForReleaseWorkflow(io, repo, workflow, branch, commit, output, 30 * 60_000, (run.attempt ?? 1) + 1);
    }
}

export async function waitForReleaseWorkflow(
    io: ReleasePublishIO, repo: string, workflow: string, branch: string, commit: string,
    output: (line: string) => void, timeoutMs = 30 * 60_000, minimumAttempt = 0,
): Promise<void> {
    const deadline = io.now() + timeoutMs;
    output(`Waiting for ${workflow} on ${branch} at ${commit} (up to 30 minutes)...`);
    while (io.now() < deadline) {
        const latest = latestWorkflowRun(io, repo, workflow, branch, commit);
        const run = latest && (latest.attempt ?? 1) >= minimumAttempt ? latest : undefined;
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
        output('The tag push was confirmed. Use --resume to inspect its release workflow before any recovery.');
        return;
    }
    output('Remaining manual steps:');
    if (!mainPushed) output('git push --no-follow-tags origin main');
    if (!ciPassed) {
        output(`Do not push the tag until main CI passes for commit ${release.commit}.`);
        output(`After fixing a failure, resume with: npm run release:tag -- ${release.tag} --resume`);
    }
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
    if (options.resume) {
        const release = planResumeRelease(root, options);
        output(`Resume plan: ${release.tag} on main at ${release.commit}.`);
        if (release.taggedCommit !== release.commit) {
            output(`The local tag at ${release.taggedCommit} can move to current main only if remote recovery checks permit it.`);
        }
        if (options.dryRun) {
            output('Local validation passed. Remote refs and workflows were not checked; no files, refs, prompts, or remote operations changed.');
            return;
        }
        if (!io) throw new Error('Resume requires Git and GitHub CLI access for read-only remote verification.');
        try { await resumeLocalRelease(release, io, !options.noPush, output, options.reuseFailedTag); }
        catch (error) {
            output(`Resume stopped. Inspect the error and rerun with: npm run release:tag -- ${release.tag} --resume`);
            output('A remote operation may have completed despite an error; rerun resume to inspect the actual refs before acting.');
            throw error;
        }
        return;
    }
    const release = runLocalRelease(root, options, output);
    if (release) {
        try { await publishLocalRelease(release, options.noPush ? undefined : io, output); }
        catch (error) {
            output(`Release publishing stopped. Resume with: npm run release:tag -- ${release.tag} --resume`);
            throw error;
        }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        if (process.argv.slice(2).includes('--help')) console.log(usage);
        else {
            const options = parseReleaseOptions(process.argv.slice(2));
            const io = !options.dryRun && (options.resume || (!options.noPush && process.stdin.isTTY && process.stdout.isTTY))
                ? consolePublishIO(process.cwd()) : undefined;
            if (options.resume && (!process.stdin.isTTY || !process.stdout.isTTY)) options.noPush = true;
            await runReleaseCommand(process.cwd(), options, io);
        }
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
}
