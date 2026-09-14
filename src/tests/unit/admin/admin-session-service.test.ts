import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Response } from 'express';
import {
    ADMIN_RESTART_HANDOFF_LIFETIME_MS,
    AdminSessionManager,
    createAdminSessionClaims,
    isSessionValid,
    getSessionRemainingMs,
    adminSessionManager,
} from '@server/security/adminSessionService';
import {
    ADMIN_SESSION_COOKIE_NAME,
    ADMIN_SESSION_COOKIE_PATH,
    clearAdminSessionCookie,
    readAdminSessionCredential,
    setAdminSessionCookie,
} from '@server/security/adminSessionCookie';

interface CookieCall {
    kind: 'set' | 'clear';
    name: string;
    value?: string;
    options: Record<string, unknown>;
}

function createCookieResponseStub(): { response: Response; calls: CookieCall[] } {
    const calls: CookieCall[] = [];
    const response = {
        cookie(name: string, value: string, options: Record<string, unknown>) {
            calls.push({ kind: 'set', name, value, options });
            return response;
        },
        clearCookie(name: string, options: Record<string, unknown>) {
            calls.push({ kind: 'clear', name, options });
            return response;
        },
    } as unknown as Response;
    return { response, calls };
}

async function runAdminSessionServiceTests(): Promise<void> {
    console.log('Running admin session service tests...');
    adminSessionManager.initialize();

    const durationMs = 15 * 60 * 1000;
    const claims = createAdminSessionClaims('test-admin-1', durationMs);
    assert.equal(claims.principalType, 'app-admin');
    assert.equal(claims.adminId, 'test-admin-1');
    assert.ok(claims.csrfToken.length >= 16);
    assert.equal(isSessionValid(claims), true);
    assert.ok(getSessionRemainingMs(claims) > 0);

    const expiredClaims = createAdminSessionClaims('expired-admin', durationMs);
    expiredClaims.expiresAt = Date.now() - 1;
    assert.equal(isSessionValid(expiredClaims), false);
    assert.equal(getSessionRemainingMs(expiredClaims), 0);

    // The browser credential is random lookup material, not serialized claims.
    const opaqueToken = adminSessionManager.storeSession(claims);
    assert.match(opaqueToken, /^[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(opaqueToken, /test-admin-1|app-admin/);
    assert.throws(() => JSON.parse(opaqueToken));
    assert.equal(adminSessionManager.getSession(opaqueToken)?.adminId, 'test-admin-1');
    assert.equal(adminSessionManager.getSession('unknown-session'), null);

    assert.equal(
        readAdminSessionCredential({ headers: { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${opaqueToken}` } } as any),
        opaqueToken,
    );
    assert.equal(
        readAdminSessionCredential({ headers: { authorization: `Bearer ${opaqueToken}` } } as any),
        opaqueToken,
    );

    const cookieStub = createCookieResponseStub();
    setAdminSessionCookie(cookieStub.response, opaqueToken, false);
    clearAdminSessionCookie(cookieStub.response, false);
    assert.deepEqual(cookieStub.calls[0], {
        kind: 'set',
        name: ADMIN_SESSION_COOKIE_NAME,
        value: opaqueToken,
        options: {
            httpOnly: true,
            sameSite: 'strict',
            secure: false,
            path: ADMIN_SESSION_COOKIE_PATH,
            maxAge: durationMs,
        },
    });
    assert.deepEqual(cookieStub.calls[1], {
        kind: 'clear',
        name: ADMIN_SESSION_COOKIE_NAME,
        options: {
            httpOnly: true,
            sameSite: 'strict',
            secure: false,
            path: ADMIN_SESSION_COOKIE_PATH,
        },
    });

    const secureCookieStub = createCookieResponseStub();
    setAdminSessionCookie(secureCookieStub.response, opaqueToken, true);
    clearAdminSessionCookie(secureCookieStub.response, true);
    assert.equal(secureCookieStub.calls[0].options.secure, true);
    assert.equal(secureCookieStub.calls[1].options.secure, true);

    adminSessionManager.revokeSession(opaqueToken);
    assert.equal(adminSessionManager.getSession(opaqueToken), null);

    const adminTokens = Array.from({ length: 3 }, () => (
        adminSessionManager.storeSession(createAdminSessionClaims('admin-456', durationMs))
    ));
    adminSessionManager.revokeAllForAdmin('admin-456');
    for (const token of adminTokens) {
        assert.equal(adminSessionManager.getSession(token), null);
    }

    const handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-admin-handoff-'));
    const handoffPath = path.join(handoffDir, 'handoff.json');
    try {
        const oldManager = new AdminSessionManager();
        const restartClaims = createAdminSessionClaims('restart-admin', durationMs);
        const restartToken = oldManager.storeSession(restartClaims);
        assert.equal(oldManager.prepareSupervisedRestartHandoff(handoffPath), 1);

        const onDisk = fs.readFileSync(handoffPath, 'utf8');
        assert.doesNotMatch(onDisk, new RegExp(restartToken));

        const replacementManager = new AdminSessionManager();
        assert.equal(replacementManager.restoreSupervisedRestartHandoff(handoffPath), 1);
        assert.equal(fs.existsSync(handoffPath), false);
        assert.equal(replacementManager.getSession(restartToken)?.adminId, 'restart-admin');
        assert.equal(replacementManager.restoreSupervisedRestartHandoff(handoffPath), 0);

        const expiredPath = path.join(handoffDir, 'expired.json');
        const expiredManager = new AdminSessionManager();
        const expiredToken = expiredManager.storeSession(createAdminSessionClaims('expired-restart', durationMs));
        const preparedAt = Date.now();
        assert.equal(expiredManager.prepareSupervisedRestartHandoff(expiredPath, preparedAt), 1);
        const coldManager = new AdminSessionManager();
        assert.equal(
            coldManager.restoreSupervisedRestartHandoff(
                expiredPath,
                preparedAt + ADMIN_RESTART_HANDOFF_LIFETIME_MS + 1,
            ),
            0,
        );
        assert.equal(coldManager.getSession(expiredToken), null);
        assert.equal(fs.existsSync(expiredPath), false);
    } finally {
        fs.rmSync(handoffDir, { recursive: true, force: true });
    }

    adminSessionManager.shutdown();
    console.log('  All session service tests passed!');
}

export function run(): Promise<void> {
    return runAdminSessionServiceTests();
}
