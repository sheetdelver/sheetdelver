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
    resolvePublicGithubRepositoryManifestUrl,
} from '@modules/registry/server';
import {
    getArtifact,
    getArtifactVerification,
    loadArtifactStore,
} from '@modules/registry/distribution/artifactStore';
import { createModuleReleaseManifest } from '@modules/registry/distribution/releaseManifest';
import type { PublicDistributionDependencies } from '@modules/registry/distribution/publicDistributionClient';

const MODULE_ID = 'public-release-test';
const MANIFEST_URL = `https://github.com/example/${MODULE_ID}/releases/download/v1.0.0/sheet-delver-manifest.json`;
const ARCHIVE_URL = `https://github.com/example/${MODULE_ID}/releases/download/v1.0.0/${MODULE_ID}-1.0.0.tgz`;

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
