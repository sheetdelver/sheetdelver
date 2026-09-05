import { strict as assert } from 'node:assert';
import { isAdminOriginRequestAllowed } from '@server/security/policies';
import {
    isAdminRequestHostAllowed,
    resolveAdminOrigin,
} from '@shared/security/adminOrigin';
import {
    DEFAULT_ADMIN_ALLOWED_NETWORKS,
    isAdminClientAddressAllowed,
    validateAdminAllowedNetworks,
} from '@server/security/adminNetwork';

function runAdminNetworkTests(): void {
    assert.equal(isAdminClientAddressAllowed('127.0.0.1', DEFAULT_ADMIN_ALLOWED_NETWORKS), true);
    assert.equal(isAdminClientAddressAllowed('::1', DEFAULT_ADMIN_ALLOWED_NETWORKS), true);
    assert.equal(isAdminClientAddressAllowed('::ffff:127.0.0.1', DEFAULT_ADMIN_ALLOWED_NETWORKS), true);
    assert.equal(isAdminClientAddressAllowed('192.168.50.42', ['192.168.50.0/24']), true);
    assert.equal(isAdminClientAddressAllowed('192.168.51.42', ['192.168.50.0/24']), false);
    assert.equal(isAdminClientAddressAllowed('10.20.30.40', ['10.0.0.0/8']), true);
    assert.throws(() => validateAdminAllowedNetworks([]), /At least one/);
    assert.throws(() => validateAdminAllowedNetworks(['example.test/24']), /IP address/);
    assert.throws(() => validateAdminAllowedNetworks(['192.168.1.0/99']), /prefix/);
}

function runAdminOriginTests(): void {
    const defaults = resolveAdminOrigin({ appOrigin: 'http://localhost:3000', env: {} });
    assert.deepEqual(defaults, {
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
        secure: false,
    });

    const configured = resolveAdminOrigin({
        appOrigin: 'http://localhost:8000',
        configuredOrigin: 'https://sheetdelver.juvi.dev',
        env: {},
    });
    assert.deepEqual(configured, {
        origin: 'https://sheetdelver.juvi.dev',
        host: 'sheetdelver.juvi.dev',
        secure: true,
    });
    assert.throws(
        () => resolveAdminOrigin({ appOrigin: 'http://localhost:3000', configuredOrigin: 'ftp://admin.test', env: {} }),
        /http or https/,
    );
    assert.throws(
        () => resolveAdminOrigin({ appOrigin: 'http://localhost:3000', configuredOrigin: 'https://admin.test/path', env: {} }),
        /only scheme/,
    );

    assert.equal(isAdminRequestHostAllowed('sheetdelver.juvi.dev', configured.origin), true);
    assert.equal(isAdminRequestHostAllowed('sheetdelver.forthelute.com', configured.origin), false);
    assert.equal(isAdminRequestHostAllowed(null, configured.origin), false);

    assert.equal(isAdminOriginRequestAllowed({ origin: configured.origin }, configured.origin), true);
    assert.equal(isAdminOriginRequestAllowed({ origin: 'https://sheetdelver.forthelute.com' }, configured.origin), false);
    assert.equal(isAdminOriginRequestAllowed({
        referer: `${configured.origin}/admin`,
        fetchSite: 'same-origin',
    }, configured.origin), true);
    assert.equal(isAdminOriginRequestAllowed({
        referer: 'https://sheetdelver.forthelute.com/actors/abc',
        fetchSite: 'same-site',
    }, configured.origin), false);
    // Origin-less tools still require an allowed network and normal admin auth.
    assert.equal(isAdminOriginRequestAllowed({}, configured.origin), true);
}

export function run(): void {
    runAdminNetworkTests();
    runAdminOriginTests();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('localhost-policy.test.ts passed');
}
