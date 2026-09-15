import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    MODULE_RELEASE_HISTORY_SCHEMA_VERSION,
    resolveModuleReleaseHistoryEntry,
    validateModuleReleaseHistory,
    type ModuleReleaseHistoryDocument,
} from '@modules/registry/releaseHistory';
import { createModuleReleaseManifest } from '@modules/registry/releaseManifest';
import { generateReleaseHistory } from '../../../scripts/tools/modules/generate-release-history';
import { compareReleaseVersions } from '@shared/utils/releaseVersion';

const INTEGRITY = `sha256:${'a'.repeat(64)}`;

function releaseManifest(version: string, publishedAt: number) {
    return createModuleReleaseManifest({
        id: 'history-test',
        title: 'History Test',
        version,
        manifest: { ui: 'dist/ui.js', logic: 'dist/logic.js' },
        compatibility: {
            coreVersion: '>=0.9.0 <1.0.0',
            apiContracts: { 'module-api': '>=1.0.0 <2.0.0' },
        },
    }, {
        url: `history-test-${version}.tgz`,
        size: 1024,
        integrity: INTEGRITY,
    }, { publishedAt });
}

function validHistory(): ModuleReleaseHistoryDocument {
    return {
        schemaVersion: MODULE_RELEASE_HISTORY_SCHEMA_VERSION,
        moduleId: 'history-test',
        generatedAt: 1789000000000,
        releases: [{
            version: '1.0.0',
            manifest: 'https://github.com/example/history-test/releases/download/v1.0.0/sheet-delver-manifest.json',
            compatibility: { coreVersion: '>=0.9.0 <1.0.0' },
        }],
    };
}

export function run() {
    assert.equal(compareReleaseVersions('1.0.0-beta.2', '1.0.0-beta.10') < 0, true);
    assert.equal(compareReleaseVersions('1.0.0-beta', '1.0.0') < 0, true);
    assert.equal(compareReleaseVersions('1.0.0+build.1', '1.0.0+build.2'), 0);
    assert.equal(compareReleaseVersions('0.9', '0.10') < 0, true);

    const valid = validHistory();
    assert.deepEqual(validateModuleReleaseHistory(valid), { valid: true, errors: [] });
    assert.equal(resolveModuleReleaseHistoryEntry(valid, '1.0.0')?.version, '1.0.0');

    const duplicate = validHistory();
    duplicate.releases.push({ ...duplicate.releases[0] });
    assert.equal(validateModuleReleaseHistory(duplicate).valid, false);

    const incompatibleShape = validHistory();
    incompatibleShape.releases[0].compatibility = { coreVersion: '' };
    assert.equal(
        validateModuleReleaseHistory(incompatibleShape).errors.some((error) => error.includes('compatibility')),
        true,
    );

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-release-history-'));
    try {
        const currentPath = path.join(tempRoot, 'current.json');
        const previousRoot = path.join(tempRoot, 'previous');
        const previousPath = path.join(previousRoot, 'v0.9.0', 'sheet-delver-manifest.json');
        const outputPath = path.join(tempRoot, 'sheet-delver-releases.json');
        fs.mkdirSync(path.dirname(previousPath), { recursive: true });
        fs.writeFileSync(currentPath, JSON.stringify(releaseManifest('1.0.0', 200)));
        fs.writeFileSync(previousPath, JSON.stringify(releaseManifest('0.9.0', 100)));

        const generated = generateReleaseHistory({
            moduleId: 'history-test',
            repository: 'https://github.com/example/history-test',
            currentManifestPath: currentPath,
            currentTag: 'v1.0.0',
            previousDirectory: previousRoot,
            outputPath,
            now: () => 300,
        });
        assert.deepEqual(generated.releases.map((entry) => entry.version), ['1.0.0', '0.9.0']);
        assert.equal(generated.releases[1].manifest.includes('/download/v0.9.0/'), true);
        assert.deepEqual(generated.releases[0].compatibility, releaseManifest('1.0.0', 200).module.compatibility);
        assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), generated);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('module-release-history.test.ts passed');
}
