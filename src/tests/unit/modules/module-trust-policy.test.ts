import { strict as assert } from 'node:assert';
import type { SystemModuleInfo } from '@modules/registry/types';
import {
    evaluateTrustPolicy,
    getDefaultModuleTrustPolicy,
    resolveEffectiveTrustTier,
} from '@modules/registry/trustPolicy';

function manifest(tier?: 'first-party' | 'verified-third-party' | 'unverified'): SystemModuleInfo {
    return {
        id: 'test-module',
        title: 'Test Module',
        manifest: {
            ui: 'module/ui',
            logic: 'module/logic',
        },
        trust: tier ? { tier } : undefined,
    };
}

export function run() {
    const devDefaults = getDefaultModuleTrustPolicy({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    assert.equal(devDefaults.minimumTrustTier, 'unverified');

    const prodDefaults = getDefaultModuleTrustPolicy({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    assert.equal(prodDefaults.minimumTrustTier, 'verified-third-party');

    // Backward-compat: no trust declaration defaults to first-party
    assert.equal(resolveEffectiveTrustTier(manifest(undefined)), 'first-party');

    // Block unverified in production baseline
    const blocked = evaluateTrustPolicy(
        manifest('unverified'),
        prodDefaults,
        { env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv, operation: 'install' }
    );
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason?.includes('below required minimum'), true);

    // Allow verified in production baseline
    const allowed = evaluateTrustPolicy(
        manifest('verified-third-party'),
        prodDefaults,
        { env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv, operation: 'upgrade' }
    );
    assert.equal(allowed.allowed, true);

    // Allow unverified in development when policy says so
    const devAllowed = evaluateTrustPolicy(
        manifest('unverified'),
        devDefaults,
        { env: { NODE_ENV: 'development' } as NodeJS.ProcessEnv, operation: 'install' }
    );
    assert.equal(devAllowed.allowed, true);

    // Admin override path when lower trust would be blocked
    const overrideAllowed = evaluateTrustPolicy(
        manifest('unverified'),
        {
            minimumTrustTier: 'verified-third-party',
            allowUnverifiedInDevelopment: false,
            requireAdminOverrideForLowerTrust: true,
            requirePermissionEscalationApproval: true,
        },
        {
            env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
            operation: 'install',
            adminOverride: true,
        }
    );
    assert.equal(overrideAllowed.allowed, true);
    assert.equal(overrideAllowed.requiresAdminOverride, true);

    console.log('module-trust-policy: PASS');
}
