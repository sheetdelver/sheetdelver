import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    initAdminCredentialStore,
    loadAdminAccount,
    saveAdminAccount,
    hashPassword,
    verifyPassword,
    createAdminAccount,
    recordFailedLogin,
    recordSuccessfulLogin,
    isAccountLocked,
    getRemainingLockoutMs,
    resetAdminPassword,
} from '@server/security/adminCredentialStore';
import type { AdminAccount } from '@server/security/types/admin-auth.types';

// Clean up the admin auth file before running tests
async function cleanupAdminAuthFile(): Promise<void> {
    try {
        const filePath = path.join(process.cwd(), '.data', 'security', 'admin-auth.json');
        await fs.rm(filePath, { force: true });
    } catch {
        // Ignore errors
    }
}

async function withTemporaryWorkingDirectory<T>(callback: () => Promise<T>): Promise<T> {
    const originalCwd = process.cwd();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sheet-delver-admin-auth-test-'));

    try {
        process.chdir(tempDir);
        return await callback();
    } finally {
        process.chdir(originalCwd);
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

async function runCredentialStoreTests(): Promise<void> {
    await withTemporaryWorkingDirectory(async () => {
        console.log('Running admin credential store tests...');

        // Clean up any existing admin auth file from previous test runs
        await cleanupAdminAuthFile();

        // Test 1: Hash and verify password
        console.log('  Test 1: Hash and verify password');
        initAdminCredentialStore(); // No pepper
        const password = 'test-password-123';
        const hash = await hashPassword(password);
        assert(hash.length > 0, 'Hash should be non-empty');
        assert(hash !== password, 'Hash should not equal plaintext password');

        const isValid = await verifyPassword(password, hash);
        assert.equal(isValid, true, 'Valid password should verify correctly');

        const isInvalid = await verifyPassword('wrong-password', hash);
        assert.equal(isInvalid, false, 'Invalid password should not verify');

        // Test 2: Hash with pepper
        console.log('  Test 2: Hash and verify with pepper');
        initAdminCredentialStore('my-secret-pepper');
        const hashWithPepper = await hashPassword(password);
        assert(hashWithPepper !== hash, 'Hash with pepper should differ from hash without pepper');

        const isValidWithPepper = await verifyPassword(password, hashWithPepper);
        assert.equal(isValidWithPepper, true, 'Valid password with pepper should verify');

        const isInvalidWithoutPepper = await verifyPassword(password, hash);
        assert.equal(isInvalidWithoutPepper, false, 'Password without pepper should not verify hash made with pepper');

        // Test 3: Create admin account
        console.log('  Test 3: Create admin account');
        await cleanupAdminAuthFile();
        initAdminCredentialStore(); // Reset pepper

        const account = await createAdminAccount('initial-password');
        assert(account.adminId, 'Account should have adminId');
        assert(account.passwordHash, 'Account should have passwordHash');
        assert.equal(account.failedLoginCount, 0, 'New account should have 0 failed logins');
        assert.equal(account.lockedUntil, undefined, 'New account should not be locked');

        // Check that second create fails
        try {
            await createAdminAccount('another-password');
            assert.fail('Should not allow creating second admin account');
        } catch (error: any) {
            assert(error.message.includes('already exists'), 'Should throw error about existing account');
        }

        // Test 4: Record failed login and lockout
        console.log('  Test 4: Record failed login and lockout');
        const testAccount: AdminAccount = {
            adminId: 'test-admin',
            passwordHash: await hashPassword('test'),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            passwordChangedAt: Date.now(),
            failedLoginCount: 0,
        };

        for (let i = 0; i < 5; i++) {
            await recordFailedLogin(testAccount);
        }

        assert.equal(testAccount.failedLoginCount, 5, 'Should have 5 failed logins');
        assert(testAccount.lockedUntil !== undefined, 'Account should be locked after 5 attempts');
        assert(isAccountLocked(testAccount), 'isAccountLocked should return true');

        const remainingMs = getRemainingLockoutMs(testAccount);
        assert(remainingMs > 0, 'Should have remaining lockout time');
        assert(remainingMs <= 15 * 60 * 1000, 'Lockout should be 15 minutes or less');

        // Test 5: Record successful login
        console.log('  Test 5: Record successful login and reset counters');
        await recordSuccessfulLogin(testAccount);
        assert.equal(testAccount.failedLoginCount, 0, 'Failed login count should reset to 0');
        assert.equal(testAccount.lockedUntil, undefined, 'Lock should be cleared');
        assert(!isAccountLocked(testAccount), 'isAccountLocked should return false');

        // Test 6: Expired lockout
        console.log('  Test 6: Check expired lockout');
        const expiredLockAccount: AdminAccount = {
            adminId: 'expired-lock',
            passwordHash: 'fake',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            passwordChangedAt: Date.now(),
            failedLoginCount: 5,
            lockedUntil: Date.now() - 1000,
        };
        assert(!isAccountLocked(expiredLockAccount), 'Expired lock should not be active');
        assert.equal(getRemainingLockoutMs(expiredLockAccount), 0, 'Expired lock should have 0 remaining time');

        // Test 7: Reset password clears lockout counters
        console.log('  Test 7: Reset password clears lockout state');
        const originalAccount = await loadAdminAccount();
        assert(originalAccount, 'Admin account should exist for reset test');

        if (!originalAccount) {
            throw new Error('Expected admin account for reset test');
        }

        originalAccount.failedLoginCount = 5;
        originalAccount.lockedUntil = Date.now() + 5 * 60 * 1000;
        await saveAdminAccount(originalAccount);

        const resetAccount = await resetAdminPassword('new-reset-password');
        assert.equal(resetAccount.failedLoginCount, 0, 'Reset should clear failed login count');
        assert.equal(resetAccount.lockedUntil, undefined, 'Reset should clear lockout');

        const resetValid = await verifyPassword('new-reset-password', resetAccount.passwordHash);
        assert.equal(resetValid, true, 'Reset password should verify against updated hash');

        await cleanupAdminAuthFile();
        console.log('  All credential store tests passed!');
    });
}

export function run(): Promise<void> {
    return runCredentialStoreTests();
}
