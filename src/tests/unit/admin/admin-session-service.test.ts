import { strict as assert } from 'node:assert';
import {
    createAdminSessionClaims,
    isSessionValid,
    getSessionRemainingMs,
    serializeSessionClaims,
    parseAndValidateToken,
    adminSessionManager,
} from '@server/security/adminSessionService';

async function runAdminSessionServiceTests(): Promise<void> {
    console.log('Running admin session service tests...');

    // Test 1: Create session claims with correct principal type
    console.log('  Test 1: Create and validate session claims');
    const adminId = 'test-admin-1';
    const durationMs = 15 * 60 * 1000; // 15 minutes
    const claims = createAdminSessionClaims(adminId, durationMs);

    assert.equal(claims.principalType, 'app-admin', 'Claims should have principalType "app-admin"');
    assert.equal(claims.adminId, adminId, 'Claims should include adminId');
    assert(Number.isInteger(claims.issuedAt), 'issuedAt should be a timestamp');
    assert(Number.isInteger(claims.expiresAt), 'expiresAt should be a timestamp');
    assert(claims.expiresAt > claims.issuedAt, 'expiresAt should be after issuedAt');
    assert(typeof claims.csrfToken === 'string' && claims.csrfToken.length >= 16, 'Claims should include CSRF token');

    // Test 2: Check session validity
    console.log('  Test 2: Check session validity');
    assert.equal(isSessionValid(claims), true, 'Fresh session should be valid');

    const pastClaims = {
        principalType: 'app-admin' as const,
        adminId: 'test',
        issuedAt: Date.now() - 2000,
        expiresAt: Date.now() - 1000, // Expired 1 second ago
    };
    assert.equal(isSessionValid(pastClaims), false, 'Expired session should not be valid');

    // Test 3: Get remaining time
    console.log('  Test 3: Get remaining session time');
    const remainingMs = getSessionRemainingMs(claims);
    assert(remainingMs > 0, 'Fresh session should have remaining time');
    assert(remainingMs <= durationMs, 'Remaining time should not exceed duration');

    const expiredRemaining = getSessionRemainingMs(pastClaims);
    assert.equal(expiredRemaining, 0, 'Expired session should have 0 remaining time');

    // Test 4: Serialize and parse token
    console.log('  Test 4: Serialize and parse token');
    const tokenStr = serializeSessionClaims(claims);
    assert(typeof tokenStr === 'string', 'Serialized token should be a string');
    assert(tokenStr.length > 0, 'Serialized token should not be empty');

    const parsedClaims = parseAndValidateToken(tokenStr);
    assert(parsedClaims !== null, 'Valid token should parse successfully');
    assert.equal(parsedClaims?.principalType, 'app-admin', 'Parsed token should have correct principal type');
    assert.equal(parsedClaims?.adminId, adminId, 'Parsed token should have correct adminId');
    assert.equal(parsedClaims?.csrfToken, claims.csrfToken, 'Parsed token should preserve CSRF token');

    const invalidToken = parseAndValidateToken('invalid-json');
    assert.equal(invalidToken, null, 'Invalid JSON should return null');

    const wrongPrincipalToken = serializeSessionClaims({
        principalType: 'user' as any,
        adminId: 'test',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 1000,
    });
    const wrongPrincipal = parseAndValidateToken(wrongPrincipalToken);
    assert.equal(wrongPrincipal, null, 'Token with wrong principal type should return null');

    // Test 5: Session manager store and retrieve
    console.log('  Test 5: Session manager store and retrieve');
    adminSessionManager.initialize();

    const testClaims = createAdminSessionClaims('admin-123', 15 * 60 * 1000);
    const storedToken = adminSessionManager.storeSession(testClaims);
    assert(typeof storedToken === 'string', 'Stored token should be a string');

    const retrieved = adminSessionManager.getSession(storedToken);
    assert(retrieved !== null, 'Stored session should be retrievable');
    assert.equal(retrieved?.adminId, 'admin-123', 'Retrieved session should have correct adminId');

    const nonExisting = adminSessionManager.getSession('non-existing-token');
    assert.equal(nonExisting, null, 'Non-existing session should return null');

    // Test 6: Revoke session
    console.log('  Test 6: Revoke session');
    adminSessionManager.revokeSession(storedToken);
    const afterRevoke = adminSessionManager.getSession(storedToken);
    assert.equal(afterRevoke, null, 'Revoked session should return null');

    // Test 7: Revoke all for admin
    console.log('  Test 7: Revoke all sessions for admin');
    const admin2Sessions = [];
    for (let i = 0; i < 3; i++) {
        const claims = createAdminSessionClaims('admin-456', 15 * 60 * 1000);
        const token = adminSessionManager.storeSession(claims);
        admin2Sessions.push(token);
    }

    // Verify all 3 are stored
    for (const token of admin2Sessions) {
        assert(adminSessionManager.getSession(token) !== null, 'Session should exist before revoke');
    }

    // Revoke all for admin-456
    adminSessionManager.revokeAllForAdmin('admin-456');

    // Verify all 3 are revoked
    for (const token of admin2Sessions) {
        assert.equal(adminSessionManager.getSession(token), null, 'Session should be null after revoke all');
    }

    adminSessionManager.shutdown();
    console.log('  All session service tests passed!');
}

export function run(): Promise<void> {
    return runAdminSessionServiceTests();
}
