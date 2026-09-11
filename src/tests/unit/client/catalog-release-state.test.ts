import assert from 'node:assert/strict';
import { isInstalledReleaseCurrent } from '../../../app/(admin)/lib/catalogReleaseState';

export function run() {
    const release = {
        version: '0.5',
        integrity: `sha256:${'a'.repeat(64)}`,
    };

    assert.equal(isInstalledReleaseCurrent(release, {
        version: '0.5',
        integrity: release.integrity,
    }), true);
    assert.equal(isInstalledReleaseCurrent(release, {
        version: '0.4',
        integrity: release.integrity,
    }), false);
    assert.equal(isInstalledReleaseCurrent(release, {
        version: '0.5',
        integrity: `sha256:${'b'.repeat(64)}`,
    }), false);
    assert.equal(isInstalledReleaseCurrent(release, { version: '0.5' }), false);
    assert.equal(isInstalledReleaseCurrent(undefined, {
        version: '0.5',
        integrity: release.integrity,
    }), false);

    console.log('  - Catalog release identity: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) run();
