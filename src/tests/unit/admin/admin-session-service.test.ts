import { strict as assert } from 'node:assert';
import type { Response } from 'express';
import {
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

    adminSessionManager.shutdown();
    console.log('  All session service tests passed!');
}

export function run(): Promise<void> {
    return runAdminSessionServiceTests();
}
