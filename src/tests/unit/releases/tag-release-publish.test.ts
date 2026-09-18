import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
    acceptsPush, publishLocalRelease, releaseRepository, waitForReleaseWorkflow,
    type ReleasePublishIO,
} from '../../../scripts/tools/releases/tag-release';

const release = { tag: 'v1.2.3', commit: 'a'.repeat(40) };
const remote = 'git@github.com:sheetdelver/sheetdelver.git';
const completed = (branch = 'main', conclusion = 'success') => ({
    databaseId: 100, headSha: release.commit, headBranch: branch, event: 'push',
    status: 'completed', conclusion, url: 'https://github.com/sheetdelver/sheetdelver/actions/runs/100',
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
    assert.ok(releaseFailed.output.at(-1)?.includes('do not move or replace'));
    assert.ok(!releaseFailed.output.includes('git push --no-follow-tags origin v1.2.3'));

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
