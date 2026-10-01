import { strict as assert } from 'node:assert';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    extractReleaseNotes,
    prepareRelease,
    versionFromReleaseTag,
} from '../../../scripts/tools/releases/prepare-release';

export function run(): void {
    assert.equal(versionFromReleaseTag('v0.8.0'), '0.8.0');
    assert.throws(() => versionFromReleaseTag('0.8.0'), /stable vMAJOR/);
    assert.throws(() => versionFromReleaseTag('v0.8.0-rc.1'), /stable vMAJOR/);

    const changelog = [
        '# Releases',
        '',
        '## Unreleased',
        '- Not in this release',
        '',
        '## 0.8.0',
        '',
        '- Added release automation',
        '- Added release checks',
        '',
        '## 0.7.0',
        '',
        '- Older release',
        '',
    ].join('\n');

    assert.equal(
        extractReleaseNotes(changelog, '0.8.0'),
        '- Added release automation\n- Added release checks',
    );
    assert.doesNotMatch(extractReleaseNotes(changelog, '0.8.0'), /Not in this release/);
    assert.throws(() => extractReleaseNotes(changelog, '0.9.0'), /missing the exact heading/);
    assert.throws(
        () => extractReleaseNotes('## 0.8.0\n\n## 0.7.0\n- Older', '0.8.0'),
        /has no release notes/,
    );
    assert.throws(
        () => extractReleaseNotes('## 0.8.0\n- One\n## 0.8.0\n- Two', '0.8.0'),
        /duplicate headings/,
    );
    assert.throws(() => prepareRelease('v0.8.0', '0.8.1', changelog), /does not match/);
    assert.deepEqual(prepareRelease('v0.8.0', '0.8.0', changelog), {
        version: '0.8.0',
        notes: '- Added release automation\n- Added release checks',
    });

    console.log('  - release metadata: all checks passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    run();
}
