import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import {
    __resetDataDirForTests,
    getDataDir,
    getModulesDataDir,
    initDataDir,
} from '@core/paths';
import {
    __resetRegistryForTests,
    applyPublicModuleRelease,
    dryRunPublicModuleRelease,
    inspectPublicModuleRelease,
    inspectPublicModuleReleaseHistory,
    resolvePublicGithubRepositoryManifestUrl,
    resolvePublicModuleReleaseTarget,
} from '@modules/registry/server';
import {
    getArtifact,
    getArtifactVerification,
    loadArtifactStore,
    saveArtifactStore,
} from '@modules/registry/distribution/artifactStore';
import { createModuleReleaseManifest } from '@modules/registry/distribution/releaseManifest';
import type { PublicDistributionDependencies } from '@modules/registry/distribution/publicDistributionClient';

const MODULE_ID = 'public-release-test';
const MANIFEST_URL = `https://github.com/example/${MODULE_ID}/releases/download/v1.0.0/sheet-delver-manifest.json`;
const ARCHIVE_URL = `https://github.com/example/${MODULE_ID}/releases/download/v1.0.0/${MODULE_ID}-1.0.0.tgz`;
const HISTORY_URL = `https://github.com/example/${MODULE_ID}/releases/latest/download/sheet-delver-releases.json`;

function createPackage(root: string) {
    const source = path.join(root, 'source');
    const archive = path.join(root, `${MODULE_ID}-1.0.0.tgz`);
    const info = {
        id: MODULE_ID,
        title: 'Public Release Test',
        version: '1.0.0',
        manifest: { logic: 'dist/logic.js', ui: 'dist/ui.js' },
        compatibility: { coreVersion: '>=0.8.0' },
        permissions: { adminRoutes: false },
        dependencies: [],
        conflicts: [],
    };
    fs.mkdirSync(path.join(source, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(source, 'info.json'), JSON.stringify(info));
    fs.writeFileSync(path.join(source, 'dist', 'logic.js'), 'export class Adapter {}\n');
    fs.writeFileSync(path.join(source, 'dist', 'ui.js'), 'export const UI = {};\n');
    tar.create({ cwd: source, file: archive, gzip: true, portable: true, sync: true }, fs.readdirSync(source));
    const body = fs.readFileSync(archive);
    const integrity = `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`;
    const manifest = createModuleReleaseManifest(info, {
        url: `${MODULE_ID}-1.0.0.tgz`,
        size: body.length,
        integrity,
    });
    return { body, manifest };
}

function publicDependencies(manifest: unknown, archive: Buffer): PublicDistributionDependencies {
    return {
        resolveAddresses: async () => [{ address: '140.82.112.3', family: 4 }],
        requestHop: async (url) => {
            if (url.href.includes('/releases/latest/download/')) {
                return { statusCode: 302, headers: { location: MANIFEST_URL }, body: Buffer.alloc(0) };
            }
            if (url.href === MANIFEST_URL) {
                return {
                    statusCode: 200,
                    headers: { 'content-type': 'application/octet-stream' },
                    body: Buffer.from(JSON.stringify(manifest)),
                };
            }
            if (url.href === ARCHIVE_URL) {
                return {
                    statusCode: 200,
                    headers: { 'content-type': 'application/gzip' },
                    body: archive,
                };
            }
            throw new Error(`Unexpected URL: ${url.href}`);
        },
        sleep: async () => undefined,
    };
}

export async function run() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-public-release-'));
    const previousNodeEnv = process.env.NODE_ENV;
    let previousDataDir: string | null = null;
    try {
        try { previousDataDir = getDataDir(); } catch { /* paths were not initialized */ }
        Reflect.set(process.env, 'NODE_ENV', 'development');
        initDataDir(tempRoot);
        __resetRegistryForTests();

        const localDirectory = path.join(tempRoot, 'local', 'modules', MODULE_ID);
        fs.mkdirSync(localDirectory, { recursive: true });
        fs.writeFileSync(path.join(localDirectory, 'developer-marker.txt'), 'untouched');

        const { body, manifest } = createPackage(tempRoot);
        const latestUrl = resolvePublicGithubRepositoryManifestUrl(`https://github.com/example/${MODULE_ID}`);
        assert.equal(
            latestUrl,
            `https://github.com/example/${MODULE_ID}/releases/latest/download/sheet-delver-manifest.json`,
        );
        assert.throws(
            () => resolvePublicGithubRepositoryManifestUrl('github://'),
            /shortcut is invalid|owner or repository name is invalid/,
        );

        const input = {
            manifestUrl: latestUrl,
            expectedModuleId: MODULE_ID,
            policy: { allowedHosts: ['github.com'], retries: 0 },
            sourceProfileId: 'official-catalog',
        };
        const inspectedUrls: string[] = [];
        const inspectDependencies = publicDependencies(manifest, body);
        const inspectRequestHop = inspectDependencies.requestHop!;
        inspectDependencies.requestHop = async (url, address, options) => {
            inspectedUrls.push(url.href);
            return inspectRequestHop(url, address, options);
        };
        const inspected = await inspectPublicModuleRelease(input, inspectDependencies);
        assert.equal(inspected.summary.version, '1.0.0');
        assert.equal(inspected.summary.artifactUrl, ARCHIVE_URL);
        assert.equal(inspectedUrls.includes(ARCHIVE_URL), false, 'inspection must not download the archive');
        await assert.rejects(
            inspectPublicModuleRelease(
                { ...input, expectedVersion: '0.9.0' },
                publicDependencies(manifest, body),
            ),
            /does not match selected version/,
        );

        const historyDocument = {
            schemaVersion: 'sheet-delver-release-history.v1',
            moduleId: MODULE_ID,
            generatedAt: Date.now(),
            releases: [
                {
                    version: '1.0.0',
                    manifest: MANIFEST_URL,
                    compatibility: { coreVersion: '>=0.8.0 <1.0.0' },
                },
                {
                    version: '2.0.0',
                    manifest: `https://github.com/example/${MODULE_ID}/releases/download/v2.0.0/sheet-delver-manifest.json`,
                    compatibility: { coreVersion: '>=99.0.0' },
                },
            ],
        };
        const historyDependencies = publicDependencies(manifest, body);
        const historyRequestHop = historyDependencies.requestHop!;
        historyDependencies.requestHop = async (url, address, options) => {
            if (url.href === HISTORY_URL) {
                return {
                    statusCode: 200,
                    headers: { 'content-type': 'application/octet-stream' },
                    body: Buffer.from(JSON.stringify(historyDocument)),
                };
            }
            return historyRequestHop(url, address, options);
        };
        const history = await inspectPublicModuleReleaseHistory(input, historyDependencies);
        assert.equal(history.historyAvailable, true);
        assert.deepEqual(history.compatibleReleases.map((entry) => entry.version), ['1.0.0']);
        assert.equal(resolvePublicModuleReleaseTarget(history).version, '1.0.0');
        assert.throws(
            () => resolvePublicModuleReleaseTarget(history, '2.0.0'),
            /does not provide version.*compatible/,
        );

        const incompleteHistoryDependencies = publicDependencies(manifest, body);
        const incompleteHistoryRequestHop = incompleteHistoryDependencies.requestHop!;
        incompleteHistoryDependencies.requestHop = async (url, address, options) => {
            if (url.href === HISTORY_URL) {
                return {
                    statusCode: 200,
                    headers: { 'content-type': 'application/json' },
                    body: Buffer.from(JSON.stringify({
                        ...historyDocument,
                        releases: historyDocument.releases.slice(1),
                    })),
                };
            }
            return incompleteHistoryRequestHop(url, address, options);
        };
        const incompleteHistory = await inspectPublicModuleReleaseHistory(input, incompleteHistoryDependencies);
        assert.equal(incompleteHistory.historyAvailable, false);
        assert.match(incompleteHistory.historyError || '', /does not include current release/);
        assert.deepEqual(incompleteHistory.compatibleReleases.map((entry) => entry.version), ['1.0.0']);

        const preview = await dryRunPublicModuleRelease(
            'install',
            input,
            publicDependencies(manifest, body),
        );
        assert.equal(preview.wouldProceed, true, preview.blockingReasons.join(' | '));
        assert.equal(preview.release?.manifestUrl, MANIFEST_URL);
        assert.equal(preview.release?.artifactUrl, ARCHIVE_URL);
        assert.equal(preview.archive?.localSourceCollision, true);

        const installed = await applyPublicModuleRelease(
            'install',
            input,
            publicDependencies(manifest, body),
        );
        assert.equal(installed.success, true, installed.error);
        assert.equal(fs.existsSync(path.join(getModulesDataDir(), MODULE_ID, 'info.json')), true);
        assert.equal(fs.readFileSync(path.join(localDirectory, 'developer-marker.txt'), 'utf8'), 'untouched');

        const artifactStore = loadArtifactStore();
        const artifact = getArtifact(artifactStore, MODULE_ID);
        assert.equal(artifact?.source, MANIFEST_URL);
        assert.equal(artifact?.integrity, manifest.artifact.integrity);
        assert.equal(artifact?.trust?.tier, 'unverified');
        assert.equal(artifact?.sourceProfileId, 'official-catalog');
        const verification = getArtifactVerification(artifactStore, MODULE_ID);
        assert.equal(verification?.status, 'verified');
        assert.equal(verification?.signature, undefined);

        const downgradeStore = loadArtifactStore();
        downgradeStore.artifacts[MODULE_ID].version = '2.0.0';
        saveArtifactStore(downgradeStore);
        const downgradeBlocked = await dryRunPublicModuleRelease(
            'upgrade',
            input,
            publicDependencies(manifest, body),
        );
        assert.equal(downgradeBlocked.wouldProceed, false);
        assert.equal(
            downgradeBlocked.blockingReasons.some((reason) => reason.includes('requires explicit approval')),
            true,
        );
        const downgradeApproved = await dryRunPublicModuleRelease(
            'upgrade',
            { ...input, approveDowngrade: true },
            publicDependencies(manifest, body),
        );
        assert.equal(downgradeApproved.wouldProceed, true, downgradeApproved.blockingReasons.join(' | '));

        const invalidManifest = {
            ...manifest,
            artifact: { ...manifest.artifact, integrity: `sha256:${'0'.repeat(64)}` },
        };
        const blocked = await dryRunPublicModuleRelease(
            'upgrade',
            { ...input, approvePermissionEscalation: true },
            publicDependencies(invalidManifest, body),
        );
        assert.equal(blocked.wouldProceed, false);
        assert.equal(blocked.blockingReasons.some((reason) => reason.includes('SHA-256')), true);
    } finally {
        __resetRegistryForTests();
        __resetDataDirForTests(previousDataDir);
        if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
        else Reflect.set(process.env, 'NODE_ENV', previousNodeEnv);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('public-release-operations.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
