import { strict as assert } from 'node:assert';
import { resolveModulePolicyConfig } from '@server/core/config';

export function run() {
    const baseSecurityDoc = {};

    // Production defaults: stricter minimum trust and override requirement
    const production = resolveModulePolicyConfig(baseSecurityDoc, { NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    assert.equal(production.minimumTrustTier, 'verified-third-party');
    assert.equal(production.allowUnverifiedInDevelopment, false);
    assert.equal(production.requireAdminOverrideForLowerTrust, true);
    assert.equal(production.requirePermissionEscalationApproval, true);

    // Development defaults: permissive local iteration mode
    const development = resolveModulePolicyConfig(baseSecurityDoc, { NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    assert.equal(development.minimumTrustTier, 'unverified');
    assert.equal(development.allowUnverifiedInDevelopment, true);
    assert.equal(development.requireAdminOverrideForLowerTrust, false);
    assert.equal(development.requirePermissionEscalationApproval, true);

    // File values override defaults
    const fileConfigured = resolveModulePolicyConfig({
        'module-policy': {
            'minimum-trust-tier': 'first-party',
            'allow-unverified-in-development': false,
            'require-admin-override-for-lower-trust': true,
            'require-permission-escalation-approval': false,
        },
    }, { NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    assert.equal(fileConfigured.minimumTrustTier, 'first-party');
    assert.equal(fileConfigured.allowUnverifiedInDevelopment, false);
    assert.equal(fileConfigured.requireAdminOverrideForLowerTrust, true);
    assert.equal(fileConfigured.requirePermissionEscalationApproval, false);

    // Env values override file values
    const envOverride = resolveModulePolicyConfig({
        'module-policy': {
            'minimum-trust-tier': 'first-party',
            'allow-unverified-in-development': false,
            'require-admin-override-for-lower-trust': false,
            'require-permission-escalation-approval': false,
        },
    }, {
        NODE_ENV: 'production',
        APP_MODULE_POLICY_MINIMUM_TRUST_TIER: 'unverified',
        APP_MODULE_POLICY_ALLOW_UNVERIFIED_IN_DEVELOPMENT: 'true',
        APP_MODULE_POLICY_REQUIRE_ADMIN_OVERRIDE_FOR_LOWER_TRUST: 'false',
        APP_MODULE_POLICY_REQUIRE_PERMISSION_ESCALATION_APPROVAL: 'true',
    } as NodeJS.ProcessEnv);
    assert.equal(envOverride.minimumTrustTier, 'unverified');
    assert.equal(envOverride.allowUnverifiedInDevelopment, true);
    assert.equal(envOverride.requireAdminOverrideForLowerTrust, false);
    assert.equal(envOverride.requirePermissionEscalationApproval, true);

    console.log('module-policy-config: PASS');
}
