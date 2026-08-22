import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdminOneTimeCredentialStore } from '@server/security/adminOneTimeCredentialStore';

export function run(): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-admin-once-'));
    let now = 1_000_000;
    try {
        const store = new AdminOneTimeCredentialStore({
            securityDir: root,
            now: () => now,
        });

        const bootstrap = store.issue('bootstrap', 60_000);
        const bootstrapPath = path.join(root, 'admin-bootstrap.json');
        const bootstrapRecord = fs.readFileSync(bootstrapPath, 'utf8');
        assert.doesNotMatch(bootstrapRecord, new RegExp(bootstrap.token));
        assert.equal(store.hasActive('bootstrap'), true);
        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(bootstrapPath).mode & 0o777, 0o600);
        }

        assert.equal(store.consume('bootstrap', 'wrong-token'), false);
        assert.equal(fs.existsSync(bootstrapPath), true, 'failed guesses must not consume a valid token');
        assert.equal(store.consume('bootstrap', bootstrap.token), true);
        assert.equal(fs.existsSync(bootstrapPath), false);
        assert.equal(store.consume('bootstrap', bootstrap.token), false, 'bootstrap token must be single-use');

        const firstRecovery = store.issue('recovery', 10_000);
        const replacementRecovery = store.issue('recovery', 10_000);
        assert.equal(store.consume('recovery', firstRecovery.token), false, 'new CLI issuance replaces the previous nonce');
        assert.equal(store.consume('recovery', replacementRecovery.token), true);

        const expired = store.issue('recovery', 1_000);
        now += 1_001;
        assert.equal(store.consume('recovery', expired.token), false);
        assert.equal(fs.existsSync(path.join(root, 'admin-recovery.json')), false);

        const bootstrapForPurposeTest = store.issue('bootstrap', 60_000);
        assert.equal(store.consume('recovery', bootstrapForPurposeTest.token), false);
        assert.equal(store.consume('bootstrap', bootstrapForPurposeTest.token), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log('  - one-time admin bootstrap/recovery credentials: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}
