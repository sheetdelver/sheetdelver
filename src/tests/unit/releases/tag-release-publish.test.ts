import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
    acceptsPush, publishLocalRelease, releaseRepository, resumeLocalRelease, waitForReleaseWorkflow,
    type ReleasePublishIO,
} from '../../../scripts/tools/releases/tag-release';

const release = { tag: 'v1.2.3', commit: 'a'.repeat(40) };
const remote = 'git@github.com:sheetdelver/sheetdelver.git';
const completed = (branch = 'main', conclusion = 'success') => ({
    databaseId: 100, headSha: release.commit, headBranch: branch, event: 'push',
    status: 'completed', conclusion, attempt: 1, url: 'https://github.com/sheetdelver/sheetdelver/actions/runs/100',
});
function fixture(answers: boolean[] = []) {
    const calls: { program: string; args: string[] }[] = [], questions: string[] = [], output: string[] = [];
    let time = 0;
    const state = {
        runs: [] as unknown[],
        failure: '' as string,
        movedTag: false,
        movedMain: false,
        changedRemote: false,
        prompt: undefined as undefined | ((index: number) => void),
    };
    const io: ReleasePublishIO = {
        confirm: async question => {
            questions.push(question);
            state.prompt?.(questions.length);
            return answers.shift() ?? false;
        },
        command: (program, args) => {
            calls.push({ program, args });
            const command = [program, ...args].join(' ');
            if (state.failure && command.includes(state.failure)) throw new Error('synthetic command failure: ' + state.failure);
            if (program === 'git' && args[0] === 'remote') return state.changedRemote ? 'https://github.com/other/repo.git' : remote;
            if (program === 'git' && args[0] === 'rev-parse') return (state.movedTag && args[1].startsWith('refs/tags/')) || (state.movedMain && args[1] === 'refs/heads/main') ? 'b'.repeat(40) : release.commit;
            if (program === 'gh' && args[0] === 'run') {
                assert.equal(args[args.indexOf('--repo') + 1], 'github.com/sheetdelver/sheetdelver');
                assert.equal(args[args.indexOf('--commit') + 1], release.commit);
                const branch = args[args.indexOf('--branch') + 1];
                return JSON.stringify(state.runs.length ? state.runs.shift() : [completed(branch)]);
            }
            return '';
        },
        sleep: async ms => { time += ms; },
        now: () => time,
    };
    const pushCalls = () => calls.filter(call => call.program === 'git' && call.args[0] === 'push');
    return { io, state, calls, questions, output, pushCalls, print: (line: string) => output.push(line) };
}
function resumeFixture(answers: boolean[] = []) {
    const calls: { program: string; args: string[] }[] = [], output: string[] = [];
    const old = '0'.repeat(40), tagObject = 'c'.repeat(40);
    const state = {
        remoteMain: old, remoteTag: '' as string, localTag: tagObject,
        failMainPushAfterLanding: false, ciConclusion: 'success', releaseConclusion: 'success',
        releaseExists: false, taggedRunCommit: release.commit, runAttempt: 1,
    };
    let time = 0;
    const io: ReleasePublishIO = {
        confirm: async () => answers.shift() ?? false,
        command: (program, args) => {
            calls.push({ program, args });
            if (program === 'git' && args[0] === 'remote') return remote;
            if (program === 'git' && args[0] === 'rev-parse') return args[1].startsWith('refs/tags/') ? state.localTag : release.commit;
            if (program === 'git' && args[0] === 'ls-remote') {
                assert.equal(args[2], remote, 'remote checks must use the verified push URL');
                const ref = args.at(-1);
                if (ref === 'refs/heads/main') return `${state.remoteMain}\t${ref}`;
                return state.remoteTag ? `${state.remoteTag}\t${ref}` : '';
            }
            if (program === 'git' && args[0] === 'tag') { state.localTag = 'd'.repeat(40); return ''; }
            if (program === 'git' && args[0] === 'push') {
                if (args.at(-1)?.includes('refs/heads/main')) {
                    state.remoteMain = release.commit;
                    if (state.failMainPushAfterLanding) throw new Error('synthetic uncertain main push');
                } else if (args.at(-1)?.startsWith(':refs/tags/')) state.remoteTag = '';
                else { state.remoteTag = state.localTag; state.taggedRunCommit = release.commit; state.releaseConclusion = 'success'; }
                return '';
            }
            if (program === 'gh' && args[0] === 'release') {
                if (state.releaseExists) return JSON.stringify({ tagName: release.tag });
                throw new Error('release not found');
            }
            if (program === 'gh' && args[0] === 'run') {
                if (args[1] === 'rerun') {
                    state.runAttempt++;
                    state.ciConclusion = 'success'; state.releaseConclusion = 'success';
                    return '';
                }
                const branch = args[args.indexOf('--branch') + 1];
                const headSha = branch === 'main' ? release.commit : state.taggedRunCommit;
                return JSON.stringify([{ ...completed(branch, branch === 'main' ? state.ciConclusion : state.releaseConclusion), headSha, attempt: state.runAttempt }]);
            }
            return '';
        },
        sleep: async ms => { time += ms; },
        now: () => time,
    };
    return { io, state, calls, output, old, tagObject, print: (line: string) => output.push(line),
        pushes: () => calls.filter(call => call.program === 'git' && call.args[0] === 'push') };
}
export async function run() {
    for (const value of ['', 'n', 'No', ' true ', '1', 'yes please']) assert.equal(acceptsPush(value), false);
    for (const value of ['y', 'Y', 'yes', ' YES ']) assert.equal(acceptsPush(value), true);
    for (const url of [remote, 'https://github.com/sheetdelver/sheetdelver.git', 'ssh://git@github.com/sheetdelver/sheetdelver.git']) {
        assert.equal(releaseRepository(url), 'github.com/sheetdelver/sheetdelver');
    }
    for (const url of ['/tmp/repo', 'file:///tmp/repo', 'https://token@github.com/owner/repo', 'https://github.com/owner/repo/extra']) {
        assert.throws(() => releaseRepository(url));
    }

    const manual: string[] = [];
    await publishLocalRelease(release, undefined, line => manual.push(line));
    assert.ok(manual.includes('git push --no-follow-tags origin main'));
    assert.ok(manual.includes('git push --no-follow-tags origin v1.2.3'));
    const decline = fixture([false]);
    await publishLocalRelease(release, decline.io, decline.print);
    assert.equal(decline.calls.length, 0, 'declining main performs no commands or remote reads');
    assert.equal(decline.questions.length, 1, 'do not offer a tag before main CI');

    const later = fixture([true, false]);
    later.state.runs = [[], [{...completed(), status: 'in_progress', conclusion: null}], [completed()]];
    await publishLocalRelease(release, later.io, later.print);
    assert.equal(later.pushCalls().length, 1);
    assert.equal(later.questions.length, 2);
    assert.ok(!later.output.includes('git push --no-follow-tags origin main'));
    assert.ok(later.output.includes('git push --no-follow-tags origin v1.2.3'));
    assert.ok(later.output.some(line => line.includes('register the push')));

    const both = fixture([true, true]);
    await publishLocalRelease(release, both.io, both.print);
    assert.deepEqual(both.pushCalls().map(call => call.args), [
        ['push', '--no-follow-tags', 'origin', 'refs/heads/main:refs/heads/main'],
        ['push', '--no-follow-tags', 'origin', 'refs/tags/v1.2.3:refs/tags/v1.2.3'],
    ]);
    assert.ok(both.output.at(-1)?.includes('both passed'));
    assert.ok(!both.output.includes('Remaining manual steps:'));

    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'neutral', 'skipped']) {
        const fail = fixture([true, true]);
        fail.state.runs = [[completed('main', conclusion)]];
        await assert.rejects(publishLocalRelease(release, fail.io, fail.print), /ended with/);
        assert.equal(fail.pushCalls().length, 1);
        assert.equal(fail.questions.length, 1, 'no tag consent sought after failed CI');
    }
    for (const failure of ['gh --version', 'git push', 'gh run list']) {
        const fail = fixture([true, true]);
        fail.state.failure = failure;
        await assert.rejects(publishLocalRelease(release, fail.io, fail.print), /synthetic/);
        assert.equal(fail.questions.length, 1);
        assert.ok(fail.output.includes('git push --no-follow-tags origin v1.2.3'));
    }
    for (const change of ['movedTag', 'movedMain', 'changedRemote'] as const) {
        const race = fixture([true, true]);
        race.state.prompt = index => { if (index === 2) race.state[change] = true; };
        await assert.rejects(publishLocalRelease(release, race.io, race.print), /refs or origin changed/);
        assert.equal(race.pushCalls().length, 1);
    }
    const releaseFailed = fixture([true, true]);
    releaseFailed.state.runs = [[completed()], [completed(release.tag, 'failure')]];
    await assert.rejects(publishLocalRelease(release, releaseFailed.io, releaseFailed.print), /release.yml ended with failure/);
    assert.equal(releaseFailed.pushCalls().length, 2);
    assert.ok(releaseFailed.output.at(-1)?.includes('--resume'));
    assert.ok(!releaseFailed.output.includes('git push --no-follow-tags origin v1.2.3'));

    const resume = resumeFixture([true, true]);
    await resumeLocalRelease({ ...release, taggedCommit: release.commit }, resume.io, true, resume.print);
    assert.deepEqual(resume.pushes().map(call => call.args.at(-1)), [
        'refs/heads/main:refs/heads/main', 'refs/tags/v1.2.3:refs/tags/v1.2.3',
    ]);
    assert.equal(resume.state.remoteTag, resume.tagObject);
    const uncertain = resumeFixture([true, true]);
    uncertain.state.failMainPushAfterLanding = true;
    await assert.rejects(resumeLocalRelease({ ...release, taggedCommit: release.commit }, uncertain.io, true, uncertain.print), /uncertain main push/);
    uncertain.state.failMainPushAfterLanding = false;
    await resumeLocalRelease({ ...release, taggedCommit: release.commit }, uncertain.io, true, uncertain.print);
    assert.equal(uncertain.pushes().filter(call => call.args.at(-1)?.includes('refs/heads/main')).length, 1,
        'resume must recognize a main push that landed despite an error');
    const stale = resumeFixture();
    stale.state.remoteMain = release.commit;
    await resumeLocalRelease({ ...release, taggedCommit: stale.old }, stale.io, false, stale.print);
    assert.equal(stale.state.localTag, 'd'.repeat(40));
    assert.equal(stale.pushes().length, 0, 'no-push resume may repair an unpublished local tag only');
    const orphanedRelease = resumeFixture();
    orphanedRelease.state.releaseExists = true;
    await assert.rejects(resumeLocalRelease({ ...release, taggedCommit: orphanedRelease.old }, orphanedRelease.io, false, orphanedRelease.print), /even though its remote tag is absent/);
    assert.equal(orphanedRelease.state.localTag, orphanedRelease.tagObject, 'existing Release blocks local retagging');
    const published = resumeFixture();
    published.state.remoteMain = release.commit;
    published.state.remoteTag = published.tagObject;
    await resumeLocalRelease({ ...release, taggedCommit: release.commit }, published.io, false, published.print);
    assert.equal(published.pushes().length, 0, 'published tag is inspected, never pushed again');
    const divergent = resumeFixture([true, true]);
    divergent.state.remoteTag = 'e'.repeat(40);
    await assert.rejects(resumeLocalRelease({ ...release, taggedCommit: release.commit }, divergent.io, true, divergent.print), /never replace a published tag/);
    assert.equal(divergent.pushes().length, 0);
    const failedCi = resumeFixture([false]);
    failedCi.state.remoteMain = release.commit;
    failedCi.state.ciConclusion = 'failure';
    await assert.rejects(resumeLocalRelease({ ...release, taggedCommit: release.commit }, failedCi.io, true, failedCi.print), /ci.yml ended with failure/);
    assert.equal(failedCi.pushes().length, 0, 'failed main CI blocks tag push');
    const rerunCi = resumeFixture([true, true]);
    rerunCi.state.remoteMain = release.commit;
    rerunCi.state.ciConclusion = 'failure';
    await resumeLocalRelease({ ...release, taggedCommit: release.commit }, rerunCi.io, true, rerunCi.print);
    assert.ok(rerunCi.calls.some(call => call.program === 'gh' && call.args[0] === 'run' && call.args[1] === 'rerun'));
    assert.equal(rerunCi.pushes().length, 1, 'a successful explicit CI rerun permits tag push');
    const failedRelease = resumeFixture();
    failedRelease.state.remoteMain = release.commit;
    failedRelease.state.remoteTag = failedRelease.tagObject;
    failedRelease.state.releaseConclusion = 'failure';
    await assert.rejects(resumeLocalRelease({ ...release, taggedCommit: release.commit }, failedRelease.io, false, failedRelease.print), /release.yml ended with failure/);
    assert.equal(failedRelease.pushes().length, 0, 'failed published release is not rolled back');
    const rerunRelease = resumeFixture([true]);
    rerunRelease.state.remoteMain = release.commit;
    rerunRelease.state.remoteTag = rerunRelease.tagObject;
    rerunRelease.state.releaseConclusion = 'failure';
    await resumeLocalRelease({ ...release, taggedCommit: release.commit }, rerunRelease.io, true, rerunRelease.print);
    assert.ok(rerunRelease.calls.some(call => call.program === 'gh' && call.args[0] === 'run' && call.args[1] === 'rerun'));
    assert.equal(rerunRelease.pushes().length, 0, 'workflow rerun does not repush a tag');
    const reused = resumeFixture([true, true, true]);
    reused.state.remoteTag = reused.tagObject;
    reused.state.taggedRunCommit = reused.old;
    reused.state.releaseConclusion = 'failure';
    await resumeLocalRelease({ ...release, taggedCommit: reused.old }, reused.io, true, reused.print, true);
    assert.deepEqual(reused.pushes().map(call => call.args.at(-1)), [
        'refs/heads/main:refs/heads/main', ':refs/tags/v1.2.3', 'refs/tags/v1.2.3:refs/tags/v1.2.3',
    ]);
    assert.equal(reused.state.remoteTag, 'd'.repeat(40));
    const declinedReuse = resumeFixture([false]);
    declinedReuse.state.remoteMain = release.commit;
    declinedReuse.state.remoteTag = declinedReuse.tagObject;
    declinedReuse.state.taggedRunCommit = declinedReuse.old;
    declinedReuse.state.releaseConclusion = 'failure';
    await resumeLocalRelease({ ...release, taggedCommit: declinedReuse.old }, declinedReuse.io, true, declinedReuse.print, true);
    assert.equal(declinedReuse.state.remoteTag, declinedReuse.tagObject, 'declining recovery leaves the remote tag untouched');
    assert.equal(declinedReuse.pushes().length, 0);
    const existingRelease = resumeFixture([true, true, true]);
    existingRelease.state.remoteTag = existingRelease.tagObject;
    existingRelease.state.releaseExists = true;
    await assert.rejects(resumeLocalRelease({ ...release, taggedCommit: existingRelease.old }, existingRelease.io, true, existingRelease.print, true), /GitHub Release/);
    assert.equal(existingRelease.pushes().length, 0);
    const noFailedRun = resumeFixture([true, true, true]);
    noFailedRun.state.remoteTag = noFailedRun.tagObject;
    noFailedRun.state.taggedRunCommit = noFailedRun.old;
    await assert.rejects(resumeLocalRelease({ ...release, taggedCommit: noFailedRun.old }, noFailedRun.io, true, noFailedRun.print, true), /No completed failed release workflow/);
    assert.equal(noFailedRun.pushes().length, 0);
    const failedFixCi = resumeFixture();
    failedFixCi.state.remoteMain = release.commit;
    failedFixCi.state.remoteTag = failedFixCi.tagObject;
    failedFixCi.state.taggedRunCommit = failedFixCi.old;
    failedFixCi.state.releaseConclusion = 'failure';
    failedFixCi.state.ciConclusion = 'failure';
    await assert.rejects(resumeLocalRelease({ ...release, taggedCommit: failedFixCi.old }, failedFixCi.io, false, failedFixCi.print, true), /ci.yml ended with failure/);
    assert.equal(failedFixCi.state.remoteTag, failedFixCi.tagObject, 'fixed-source CI must pass before deleting the failed tag');

    const wrongRun = fixture();
    wrongRun.state.runs = [[
        {...completed(), headSha: 'wrong'}, {...completed(), headBranch: 'other'},
        {...completed(), event: 'pull_request'},
    ]];
    await assert.rejects(waitForReleaseWorkflow(wrongRun.io, 'github.com/sheetdelver/sheetdelver', 'ci.yml', 'main', release.commit, wrongRun.print, 1), /Timed out/);
    const missing = fixture();
    missing.state.runs = [[], []];
    await assert.rejects(waitForReleaseWorkflow(missing.io, 'github.com/sheetdelver/sheetdelver', 'ci.yml', 'main', release.commit, missing.print, 10001), /Timed out/);
    const invalid = fixture();
    invalid.state.runs = [{unexpected: true}];
    await assert.rejects(waitForReleaseWorkflow(invalid.io, 'github.com/sheetdelver/sheetdelver', 'ci.yml', 'main', release.commit, invalid.print), /invalid workflow list/);
    const cancel = fixture();
    cancel.io.confirm = async () => { throw new Error('cancelled'); };
    await assert.rejects(publishLocalRelease(release, cancel.io, cancel.print), /cancelled/);
    assert.equal(cancel.calls.length, 0);
    assert.ok(cancel.output.includes('git push --no-follow-tags origin main'));
    console.log('  - release publish confirmations and CI gates: all checks passed (mock commands only)');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run().catch(error => { console.error(error); process.exitCode = 1; });
}
