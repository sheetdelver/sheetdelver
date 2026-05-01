import { promises as fs } from 'node:fs';
import path from 'node:path';
import { hash, verify } from 'argon2';
import { logger } from '@shared/utils/logger';
import type { AdminAccount } from './types/admin-auth.types';
import { getSecurityDir } from '@core/paths';

/** Returns the admin auth file path within the resolved security directory. */
const getAdminAuthFile = () => path.join(getSecurityDir(), 'admin-auth.json');

// Optional pepper from env; if set, included during hash verification but never stored
let _adminPepper: string | undefined;

/**
 * Initialize the credential store with optional pepper from env.
 */
export function initAdminCredentialStore(pepper?: string): void {
    _adminPepper = pepper;
}

/**
 * Ensures the security directory exists within the data directory.
 */
async function ensureSecurityDir(): Promise<void> {
    const securityDir = getSecurityDir();
    try {
        await fs.mkdir(securityDir, { recursive: true });
    } catch (error) {
        logger.error(`Failed to create security directory at ${securityDir}`, error);
        throw error;
    }
}

/**
 * Set restrictive file permissions (owner read/write only: 0o600).
 * Only works on Unix-like systems; on Windows, this is a no-op.
 */
async function setRestrictivePermissions(filePath: string): Promise<void> {
    try {
        if (process.platform !== 'win32') {
            await fs.chmod(filePath, 0o600);
        }
    } catch (error) {
        logger.warn(`Failed to set restrictive permissions on ${filePath}`, error);
        // Non-fatal; log but continue
    }
}

/**
 * Load the admin account from disk.
 * Returns null if account does not exist.
 */
export async function loadAdminAccount(): Promise<AdminAccount | null> {
    const adminAuthFile = getAdminAuthFile();
    try {
        const fileContents = await fs.readFile(adminAuthFile, 'utf8');
        const account = JSON.parse(fileContents) as AdminAccount;
        return account;
    } catch (error: any) {
        // ENOENT is expected on first run
        if (error?.code === 'ENOENT') {
            return null;
        }
        logger.error(`Failed to load admin account from ${adminAuthFile}`, error);
        throw error;
    }
}

/**
 * Save the admin account to disk with restrictive permissions.
 */
export async function saveAdminAccount(account: AdminAccount): Promise<void> {
    const adminAuthFile = getAdminAuthFile();
    try {
        await ensureSecurityDir();
        const fileContents = JSON.stringify(account, null, 2);
        await fs.writeFile(adminAuthFile, fileContents, 'utf8');
        await setRestrictivePermissions(adminAuthFile);
    } catch (error) {
        logger.error(`Failed to save admin account to ${adminAuthFile}`, error);
        throw error;
    }
}

/**
 * Hash a password using Argon2id.
 * Argon2 automatically manages salt; pepper is optional.
 */
export async function hashPassword(password: string): Promise<string> {
    try {
        const combined = _adminPepper ? password + _adminPepper : password;
        return await hash(combined, {
            type: 2, // Argon2id
            memoryCost: 65536, // 64MB
            timeCost: 3,
            parallelism: 4,
        });
    } catch (error) {
        logger.error('Failed to hash password', error);
        throw error;
    }
}

/**
 * Verify a password against a stored hash.
 * Pepper is applied if configured.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    try {
        const combined = _adminPepper ? password + _adminPepper : password;
        return await verify(hash, combined);
    } catch (error) {
        logger.error('Failed to verify password', error);
        return false;
    }
}

/**
 * Create a new admin account.
 * Fails if an account already exists.
 */
export async function createAdminAccount(password: string): Promise<AdminAccount> {
    const existing = await loadAdminAccount();
    if (existing) {
        throw new Error('Admin account already exists');
    }

    const now = Date.now();
    const passwordHash = await hashPassword(password);

    const account: AdminAccount = {
        adminId: `admin-${Date.now()}`, // Simple unique ID
        passwordHash,
        createdAt: now,
        updatedAt: now,
        passwordChangedAt: now,
        failedLoginCount: 0,
    };

    await saveAdminAccount(account);
    return account;
}

/**
 * Update failed login count and apply lockout if threshold is exceeded.
 * Lockout duration: 15 minutes.
 */
export async function recordFailedLogin(account: AdminAccount): Promise<void> {
    const failureThreshold = 5;
    const lockoutDurationMs = 15 * 60 * 1000; // 15 minutes

    account.failedLoginCount += 1;
    account.updatedAt = Date.now();

    if (account.failedLoginCount >= failureThreshold) {
        account.lockedUntil = Date.now() + lockoutDurationMs;
        logger.warn(`Admin account locked due to ${account.failedLoginCount} failed login attempts`);
    }

    await saveAdminAccount(account);
}

/**
 * Unlock the account and reset failed login counter.
 */
export async function recordSuccessfulLogin(account: AdminAccount): Promise<void> {
    account.failedLoginCount = 0;
    account.lockedUntil = undefined;
    account.updatedAt = Date.now();
    await saveAdminAccount(account);
}

/**
 * Reset the admin account password and session state.
 * Used by the local reset endpoint.
 */
export async function resetAdminPassword(newPassword: string): Promise<AdminAccount> {
    const account = await loadAdminAccount();
    if (!account) {
        throw new Error('Admin account does not exist');
    }

    const passwordHash = await hashPassword(newPassword);
    account.passwordHash = passwordHash;
    account.passwordChangedAt = Date.now();
    account.updatedAt = Date.now();
    account.failedLoginCount = 0;
    account.lockedUntil = undefined;

    await saveAdminAccount(account);
    return account;
}

/**
 * Check if account is currently locked.
 */
export function isAccountLocked(account: AdminAccount): boolean {
    if (!account.lockedUntil) return false;
    return account.lockedUntil > Date.now();
}

/**
 * Get the remaining lockout time in milliseconds.
 * Returns 0 if not locked.
 */
export function getRemainingLockoutMs(account: AdminAccount): number {
    if (!account.lockedUntil) return 0;
    const remaining = account.lockedUntil - Date.now();
    return remaining > 0 ? remaining : 0;
}
