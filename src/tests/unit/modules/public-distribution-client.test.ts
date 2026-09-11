import { strict as assert } from 'node:assert';
import {
    PublicDistributionError,
    createPinnedDistributionLookup,
    fetchPublicDistributionResource,
    isDistributionHostAllowed,
    isPublicDistributionAddress,
    type PublicDistributionDependencies,
} from '@modules/registry/distribution/publicDistributionClient';

const PUBLIC_ADDRESS = { address: '93.184.216.34', family: 4 as const };

function dependencies(
    responses: Array<{ statusCode: number; headers?: Record<string, string>; body?: string }>,
    requestedUrls: string[],
): PublicDistributionDependencies {
    return {
        resolveAddresses: async () => [PUBLIC_ADDRESS],
        requestHop: async (url) => {
            requestedUrls.push(url.href);
            const response = responses.shift();
            if (!response) throw new Error('Unexpected request');
            return {
                statusCode: response.statusCode,
                headers: response.headers || { 'content-type': 'application/json' },
                body: Buffer.from(response.body || '{}'),
            };
        },
        sleep: async () => undefined,
    };
}

async function expectCode(action: () => Promise<unknown>, code: PublicDistributionError['code']) {
    await assert.rejects(action, (error: unknown) => (
        error instanceof PublicDistributionError && error.code === code
    ));
}

export async function run() {
    const pinnedLookup = createPinnedDistributionLookup(PUBLIC_ADDRESS);
    await new Promise<void>((resolve, reject) => {
        pinnedLookup('releases.example.com', { all: true }, (error, addresses) => {
            if (error) return reject(error);
            assert.deepEqual(addresses, [PUBLIC_ADDRESS]);
            resolve();
        });
    });
    await new Promise<void>((resolve, reject) => {
        pinnedLookup('releases.example.com', { all: false }, (error, address, family) => {
            if (error) return reject(error);
            assert.equal(address, PUBLIC_ADDRESS.address);
            assert.equal(family, PUBLIC_ADDRESS.family);
            resolve();
        });
    });

    assert.equal(isDistributionHostAllowed('github.com', ['github.com']), true);
    assert.equal(isDistributionHostAllowed('objects.githubusercontent.com', ['*.githubusercontent.com']), true);
    assert.equal(isDistributionHostAllowed('evilgithub.com', ['*.github.com']), false);
    assert.equal(isPublicDistributionAddress('8.8.8.8'), true);
    for (const address of [
        '127.0.0.1',
        '10.0.0.1',
        '169.254.169.254',
        '192.168.1.1',
        '::1',
        '::ffff:127.0.0.1',
        '::7f00:1',
        'fc00::1',
        'fe80::1',
        '2002:7f00:1::',
    ]) {
        assert.equal(isPublicDistributionAddress(address), false, `${address} must be rejected`);
    }

    const policy = { allowedHosts: ['releases.example.com', 'assets.example.com'], retries: 0 };
    await expectCode(
        () => fetchPublicDistributionResource('http://releases.example.com/manifest.json', {
            accept: 'application/json', maxBytes: 1024, contentType: 'json',
        }, policy),
        'invalid-url',
    );
    await expectCode(
        () => fetchPublicDistributionResource('https://user:secret@releases.example.com/manifest.json', {
            accept: 'application/json', maxBytes: 1024, contentType: 'json',
        }, policy),
        'invalid-url',
    );
    await expectCode(
        () => fetchPublicDistributionResource('https://unlisted.example.com/manifest.json', {
            accept: 'application/json', maxBytes: 1024, contentType: 'json',
        }, policy),
        'host-not-allowed',
    );

    const previousNodeEnv = process.env.NODE_ENV;
    Reflect.set(process.env, 'NODE_ENV', 'development');
    try {
        await expectCode(
            () => fetchPublicDistributionResource('https://releases.example.com/manifest.json', {
                accept: 'application/json', maxBytes: 1024, contentType: 'json',
            }, { allowedHosts: [], retries: 0 }),
            'host-not-allowed',
        );
    } finally {
        if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
        else Reflect.set(process.env, 'NODE_ENV', previousNodeEnv);
    }

    await expectCode(
        () => fetchPublicDistributionResource('https://releases.example.com/manifest.json', {
            accept: 'application/json', maxBytes: 1024, contentType: 'json',
        }, policy, {
            resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
        }),
        'unsafe-address',
    );

    const redirectedUrls: string[] = [];
    const redirected = await fetchPublicDistributionResource('https://releases.example.com/manifest.json', {
        accept: 'application/json', maxBytes: 1024, contentType: 'json',
    }, policy, dependencies([
        { statusCode: 302, headers: { location: 'https://assets.example.com/release/manifest.json' } },
        { statusCode: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"ok":true}' },
    ], redirectedUrls));
    assert.equal(redirected.finalUrl, 'https://assets.example.com/release/manifest.json');
    assert.deepEqual(redirectedUrls, [
        'https://releases.example.com/manifest.json',
        'https://assets.example.com/release/manifest.json',
    ]);

    await expectCode(
        () => fetchPublicDistributionResource('https://assets.example.com/catalog.json', {
            accept: 'application/json', maxBytes: 1024, contentType: 'json',
        }, policy, dependencies([
            { statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, body: '{}' },
        ], [])),
        'content-type-error',
    );

    const releaseManifestAsset = await fetchPublicDistributionResource(
        'https://assets.example.com/sheet-delver-manifest.json',
        { accept: 'application/json', maxBytes: 1024, contentType: 'release-manifest' },
        policy,
        dependencies([
            { statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, body: '{}' },
        ], []),
    );
    assert.equal(releaseManifestAsset.contentType, 'application/octet-stream');

    await expectCode(
        () => fetchPublicDistributionResource('https://releases.example.com/manifest.json', {
            accept: 'application/json', maxBytes: 1024, contentType: 'json',
        }, policy, dependencies([
            { statusCode: 302, headers: { location: 'https://internal.example/manifest.json' } },
        ], [])),
        'host-not-allowed',
    );

    const privateRedirectDependencies = dependencies([
        { statusCode: 302, headers: { location: 'https://assets.example.com/manifest.json' } },
    ], []);
    privateRedirectDependencies.resolveAddresses = async (hostname) => hostname === 'assets.example.com'
        ? [{ address: '10.0.0.5', family: 4 }]
        : [PUBLIC_ADDRESS];
    await expectCode(
        () => fetchPublicDistributionResource('https://releases.example.com/manifest.json', {
            accept: 'application/json', maxBytes: 1024, contentType: 'json',
        }, policy, privateRedirectDependencies),
        'unsafe-address',
    );

    await expectCode(
        () => fetchPublicDistributionResource('https://releases.example.com/archive.tgz', {
            accept: 'application/gzip', maxBytes: 3, contentType: 'archive',
        }, policy, dependencies([
            { statusCode: 200, headers: { 'content-type': 'application/gzip' }, body: 'oversized' },
        ], [])),
        'response-too-large',
    );

    let attempts = 0;
    const retried = await fetchPublicDistributionResource('https://releases.example.com/manifest.json', {
        accept: 'application/json', maxBytes: 1024, contentType: 'json',
    }, { ...policy, retries: 1 }, {
        resolveAddresses: async () => [PUBLIC_ADDRESS],
        requestHop: async () => {
            attempts += 1;
            if (attempts === 1) throw new PublicDistributionError('network-error', 'temporary', true);
            return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') };
        },
        sleep: async () => undefined,
    });
    assert.equal(retried.statusCode, 200);
    assert.equal(attempts, 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('public-distribution-client.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
