import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import {
    discardPreparedModuleArchive,
    inspectModuleArchive,
    prepareModuleArchive,
    promotePreparedModuleArchive,
} from '@modules/registry/distribution/archiveTransaction';
import { createModuleReleaseManifest } from '@modules/registry/releaseManifest';
import type { SystemModuleInfo } from '@modules/registry/types';

function writeModule(root: string, version = '1.0.0'): SystemModuleInfo {
    const info: SystemModuleInfo = {
        id: 'test-module',
        title: 'Test Module',
        version,
        manifest: {
            logic: 'dist/logic.js',
            ui: 'dist/ui.js',
        },
        compatibility: { coreVersion: '>=0.8.0 <1.0.0' },
        permissions: { network: { outbound: false } },
    };
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'info.json'), `${JSON.stringify(info, null, 2)}\n`);
    fs.writeFileSync(path.join(root, 'dist', 'logic.js'), 'export class Adapter {}\n');
    fs.writeFileSync(path.join(root, 'dist', 'ui.js'), 'export default function UI() {}\n');
    return info;
}

function createArchive(source: string, archivePath: string, entries = fs.readdirSync(source)): void {
    tar.create({
        cwd: source,
        file: archivePath,
        gzip: true,
        portable: true,
        sync: true,
    }, entries);
}

function digestArchive(archivePath: string): { size: number; integrity: string } {
    const bytes = fs.readFileSync(archivePath);
    return {
        size: bytes.length,
        integrity: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    };
}

export async function run() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-archive-transaction-'));
    try {
        const source = path.join(tempRoot, 'source');
        const archive = path.join(tempRoot, 'test-module-1.0.0.tgz');
        const info = writeModule(source);
        createArchive(source, archive);

        const inspection = inspectModuleArchive(archive);
        assert.equal(inspection.paths.includes('info.json'), true);
        assert.equal(inspection.fileCount, 3);
        assert.throws(
            () => inspectModuleArchive(archive, { maxEntries: 2 }),
            /entry limit/,
        );

        const nestedSource = path.join(tempRoot, 'nested-source');
        fs.mkdirSync(path.join(nestedSource, 'package'), { recursive: true });
        fs.copyFileSync(path.join(source, 'info.json'), path.join(nestedSource, 'package', 'info.json'));
        const nestedArchive = path.join(tempRoot, 'nested.tgz');
        createArchive(nestedSource, nestedArchive);
        assert.throws(() => inspectModuleArchive(nestedArchive), /info\.json at its root/);

        const linkSource = path.join(tempRoot, 'link-source');
        writeModule(linkSource);
        fs.symlinkSync('dist/logic.js', path.join(linkSource, 'logic-link.js'));
        const linkArchive = path.join(tempRoot, 'link.tgz');
        createArchive(linkSource, linkArchive);
        assert.throws(() => inspectModuleArchive(linkArchive), /not allowed/);

        const duplicateArchive = path.join(tempRoot, 'duplicate.tgz');
        createArchive(source, duplicateArchive, ['info.json', 'info.json']);
        assert.throws(() => inspectModuleArchive(duplicateArchive), /duplicate path/);

        const traversalArchive = path.join(tempRoot, 'traversal.tgz');
        tar.create({
            cwd: source,
            file: traversalArchive,
            gzip: true,
            preservePaths: true,
            sync: true,
        }, ['../test-module-1.0.0.tgz']);
        assert.throws(() => inspectModuleArchive(traversalArchive), /unconfined path/);

        const stagingRoot = path.join(tempRoot, 'staging');
        const modulesRoot = path.join(tempRoot, 'modules');
        const localRoot = path.join(tempRoot, 'local', 'modules', 'test-module');
        fs.mkdirSync(modulesRoot, { recursive: true });
        fs.mkdirSync(localRoot, { recursive: true });
        fs.writeFileSync(path.join(localRoot, 'developer-source.txt'), 'must remain untouched');
        const localDigestBefore = crypto.createHash('sha256')
            .update(fs.readFileSync(path.join(localRoot, 'developer-source.txt')))
            .digest('hex');

        const oldManaged = path.join(modulesRoot, 'test-module');
        fs.mkdirSync(oldManaged);
        fs.writeFileSync(path.join(oldManaged, 'old.txt'), 'old managed version');

        const archiveDigest = digestArchive(archive);
        const releaseManifest = createModuleReleaseManifest(info, {
            url: path.basename(archive),
            ...archiveDigest,
        });
        const prepared = await prepareModuleArchive({
            archivePath: archive,
            expectedModuleId: 'test-module',
            releaseManifest,
            stagingRoot,
            coreVersion: '0.8.0',
        });
        assert.equal(prepared.compatibility.compatible, true);
        assert.equal(prepared.artifactHealth.hasErrors, false);
        assert.equal(prepared.integrity, archiveDigest.integrity);

        const promotion = await promotePreparedModuleArchive(prepared, modulesRoot);
        assert.equal(promotion.replacedExisting, true);
        assert.equal(fs.existsSync(path.join(oldManaged, 'dist', 'logic.js')), true);
        assert.equal(fs.existsSync(path.join(oldManaged, 'old.txt')), false);
        promotion.rollback();
        assert.equal(fs.readFileSync(path.join(oldManaged, 'old.txt'), 'utf8'), 'old managed version');

        const preparedForCommit = await prepareModuleArchive({
            archivePath: archive,
            expectedModuleId: 'test-module',
            stagingRoot,
            coreVersion: '0.8.0',
        });
        const committedPromotion = await promotePreparedModuleArchive(preparedForCommit, modulesRoot);
        committedPromotion.commit();
        assert.equal(fs.existsSync(path.join(oldManaged, 'dist', 'ui.js')), true);

        const localDigestAfter = crypto.createHash('sha256')
            .update(fs.readFileSync(path.join(localRoot, 'developer-source.txt')))
            .digest('hex');
        assert.equal(localDigestAfter, localDigestBefore, 'managed promotion must not write to local/modules');

        const preparedToDiscard = await prepareModuleArchive({
            archivePath: archive,
            stagingRoot,
            coreVersion: '0.8.0',
        });
        const discardedDirectory = preparedToDiscard.transactionDirectory;
        discardPreparedModuleArchive(preparedToDiscard);
        assert.equal(fs.existsSync(discardedDirectory), false);

        const mismatchedRelease = createModuleReleaseManifest(
            { ...info, permissions: { adminRoutes: true } },
            { url: path.basename(archive), ...archiveDigest },
        );
        await assert.rejects(
            prepareModuleArchive({
                archivePath: archive,
                releaseManifest: mismatchedRelease,
                stagingRoot,
                coreVersion: '0.8.0',
            }),
            /field "permissions" does not match/,
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('module-archive-transaction.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
