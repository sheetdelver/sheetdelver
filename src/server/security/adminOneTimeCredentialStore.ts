import fs from 'node:fs';
import path from 'node:path';
import {
    createHash,
    randomBytes,
    timingSafeEqual,
} from 'node:crypto';
import { getSecurityDir, writeOwnerOnlyFileAtomicSync } from '@server/core/paths';

export type AdminOneTimeCredentialPurpose = 'bootstrap' | 'recovery';

export const ADMIN_BOOTSTRAP_LIFETIME_MS = 60 * 60 * 1000;
export const ADMIN_RECOVERY_LIFETIME_MS = 10 * 60 * 1000;

interface AdminOneTimeCredentialRecord {
    version: 1;
    purpose: AdminOneTimeCredentialPurpose;
    salt: string;
    digest: string;
    createdAt: number;
    expiresAt: number;
}

interface AdminOneTimeCredentialStoreOptions {
    securityDir: string;
    now?: () => number;
}

export interface IssuedAdminOneTimeCredential {
    token: string;
    expiresAt: number;
}

function credentialDigest(purpose: AdminOneTimeCredentialPurpose, salt: string, token: string): Buffer {
    return createHash('sha256')
        .update(purpose, 'utf8')
        .update('\0')
        .update(salt, 'utf8')
        .update('\0')
        .update(token, 'utf8')
        .digest();
}

export class AdminOneTimeCredentialStore {
    private readonly securityDir: string;
    private readonly now: () => number;

    public constructor(options: AdminOneTimeCredentialStoreOptions) {
        this.securityDir = options.securityDir;
        this.now = options.now ?? Date.now;
    }

    public issue(
        purpose: AdminOneTimeCredentialPurpose,
        lifetimeMs = purpose === 'bootstrap'
            ? ADMIN_BOOTSTRAP_LIFETIME_MS
            : ADMIN_RECOVERY_LIFETIME_MS,
    ): IssuedAdminOneTimeCredential {
        if (!Number.isInteger(lifetimeMs) || lifetimeMs <= 0) {
            throw new Error('One-time credential lifetime must be a positive integer');
        }
        const token = randomBytes(32).toString('base64url');
        const salt = randomBytes(16).toString('base64url');
        const createdAt = this.now();
        const record: AdminOneTimeCredentialRecord = {
            version: 1,
            purpose,
            salt,
            digest: credentialDigest(purpose, salt, token).toString('base64'),
            createdAt,
            expiresAt: createdAt + lifetimeMs,
        };
        writeOwnerOnlyFileAtomicSync(this.getPath(purpose), JSON.stringify(record));
        return { token, expiresAt: record.expiresAt };
    }

    /**
     * Validate and atomically consume one purpose-bound credential. Failed
     * guesses do not destroy the valid credential; expiry and success do.
     */
    public consume(purpose: AdminOneTimeCredentialPurpose, token: string): boolean {
        const filePath = this.getPath(purpose);
        if (!token || !fs.existsSync(filePath)) return false;

        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(`Refusing non-regular admin ${purpose} credential file`);
        }
        const record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as AdminOneTimeCredentialRecord;
        if (record.version !== 1 || record.purpose !== purpose
            || typeof record.salt !== 'string' || typeof record.digest !== 'string'
            || !Number.isInteger(record.expiresAt)) {
            throw new Error(`Invalid admin ${purpose} credential record`);
        }
        if (record.expiresAt <= this.now()) {
            fs.unlinkSync(filePath);
            return false;
        }

        const expected = Buffer.from(record.digest, 'base64');
        const actual = credentialDigest(purpose, record.salt, token);
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
            return false;
        }

        // Unlink before the privileged operation continues so two concurrent
        // requests cannot both pass validation.
        fs.unlinkSync(filePath);
        return true;
    }

    public hasActive(purpose: AdminOneTimeCredentialPurpose): boolean {
        const filePath = this.getPath(purpose);
        if (!fs.existsSync(filePath)) return false;
        const record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as AdminOneTimeCredentialRecord;
        return record.purpose === purpose && record.expiresAt > this.now();
    }

    private getPath(purpose: AdminOneTimeCredentialPurpose): string {
        return path.join(this.securityDir, `admin-${purpose}.json`);
    }
}

function productionStore(): AdminOneTimeCredentialStore {
    return new AdminOneTimeCredentialStore({ securityDir: getSecurityDir() });
}

export function issueAdminBootstrapCredential(): IssuedAdminOneTimeCredential {
    return productionStore().issue('bootstrap');
}

export function consumeAdminBootstrapCredential(token: string): boolean {
    return productionStore().consume('bootstrap', token);
}

export function issueAdminRecoveryCredential(): IssuedAdminOneTimeCredential {
    return productionStore().issue('recovery');
}

export function consumeAdminRecoveryCredential(token: string): boolean {
    return productionStore().consume('recovery', token);
}
