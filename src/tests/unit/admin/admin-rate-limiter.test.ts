import { strict as assert } from 'node:assert';
import type { AppConfig } from '@shared/interfaces';
import {
    getAdminLoginRateLimitSettings,
    isAdminLoginProtectionEnabled,
} from '@server/middleware/rateLimiters';

const testConfig: AppConfig = {
    app: {
        host: '127.0.0.1',
        port: 3000,
        apiPort: 3000,
        adminOrigin: 'http://127.0.0.1:3000',
        protocol: 'http',
        chatHistory: 50,
        version: 'test',
        url: 'http://127.0.0.1:3000',
    },
    foundry: {
        host: '127.0.0.1',
        port: 30000,
        protocol: 'http',
        url: 'http://127.0.0.1:30000',
    },
    debug: {
        enabled: false,
        level: 1,
    },
    security: {
        rateLimit: {
            enabled: true,
            windowMinutes: 15,
            maxAttempts: 6,
        },
        bodyLimit: '10mb',
        adminAllowedNetworks: ['127.0.0.0/8', '::1/128'],
        modulePolicy: {
            minimumTrustTier: 'unverified',
            allowUnverifiedInDevelopment: true,
            requireAdminOverrideForLowerTrust: false,
            requirePermissionEscalationApproval: true,
        },
        cors: {
            allowAllOrigins: false,
            allowedOrigins: ['http://127.0.0.1:3000'],
        },
    },
};

async function runAdminRateLimiterTests(): Promise<void> {
    console.log('Running admin rate limiter tests...');

    console.log('  Test 1: Uses stricter max attempts than standard login');
    const strictSettings = getAdminLoginRateLimitSettings(testConfig);
    assert.equal(strictSettings.windowMinutes, 15, 'Admin limiter should keep configured window');
    assert.equal(strictSettings.maxAttempts, 3, 'Admin limiter should use half of configured max attempts');

    console.log('  Test 2: Floors to minimum safe values');
    const tinyConfig: AppConfig = {
        ...testConfig,
        security: {
            ...testConfig.security,
            rateLimit: {
                enabled: true,
                windowMinutes: 0,
                maxAttempts: 1,
            },
        },
    };
    const tinySettings = getAdminLoginRateLimitSettings(tinyConfig);
    assert.equal(tinySettings.windowMinutes, 1, 'Window should floor to 1 minute minimum');
    assert.equal(tinySettings.maxAttempts, 1, 'Max attempts should floor to 1 minimum');

    console.log('  Test 3: Bypasses admin login protection only in explicit development');
    assert.equal(
        isAdminLoginProtectionEnabled({ NODE_ENV: 'production' }),
        true,
        'Production should enforce admin login throttling and account lockout'
    );
    assert.equal(
        isAdminLoginProtectionEnabled({ NODE_ENV: 'development' }),
        false,
        'Development should not enforce admin login throttling or account lockout'
    );
    assert.equal(
        isAdminLoginProtectionEnabled({}),
        true,
        'An unspecified environment should fail closed instead of assuming development'
    );

    console.log('  All admin rate limiter tests passed!');
}

export function run(): Promise<void> {
    return runAdminRateLimiterTests();
}
