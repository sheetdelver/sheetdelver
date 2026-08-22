/**
 * Admin auth endpoints: setup, login, reset, status. Carved out of the
 * monolithic createAdminRouter.ts per ADR-0022 Phase 4.
 */
import express from 'express';
import type { RateLimitRequestHandler } from 'express-rate-limit';
import { logger } from '@shared/utils/logger';
import {
    loadAdminAccount,
    createAdminAccount,
    verifyPassword,
    recordFailedLogin,
    recordSuccessfulLogin,
    isAccountLocked,
    getRemainingLockoutMs,
    resetAdminPassword,
} from '@server/security/adminCredentialStore';
import {
    createAdminSessionClaims,
    adminSessionManager,
} from '@server/security/adminSessionService';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { requireAdminAuth, auditAdminAction } from '@server/middleware/requireAdminAuth';
import { requireAdminCsrf } from '@server/middleware/requireAdminCsrf';
import type { AdminLoginRequest } from '@server/security/types/admin-auth.types';
import {
    clearAdminSessionCookie,
    setAdminSessionCookie,
} from '@server/security/adminSessionCookie';
import {
    consumeAdminBootstrapCredential,
    consumeAdminRecoveryCredential,
} from '@server/security/adminOneTimeCredentialStore';

export interface RegisterAdminAuthRoutesOptions {
    adminRouter: express.Router;
    adminLoginLimiter: RateLimitRequestHandler;
    requireAdminAccountExists: express.RequestHandler;
}

export function registerAdminAuthRoutes(opts: RegisterAdminAuthRoutesOptions): void {
    const { adminRouter, adminLoginLimiter, requireAdminAccountExists } = opts;

    // ============
    // Auth Endpoints (setup/login)
    // ============

    /**
     * Bootstrap setup endpoint - creates the initial admin account.
     * Only available on first run when no account exists.
     * Requires a short-lived bootstrap credential issued by the local CLI.
     * Localhost-only.
     */
    adminRouter.post('/auth/setup', adminLoginLimiter, async (req, res) => {
        try {
            const existingAccount = await loadAdminAccount();
            if (existingAccount) {
                return res.status(403).json({ error: 'Admin account already exists' });
            }

            const { bootstrapToken, password } = req.body as {
                bootstrapToken?: string;
                password?: string;
            };

            // Validate password
            if (!password || typeof password !== 'string' || password.length < 8 || password.length > 1024) {
                return res.status(400).json({ error: 'Password must be between 8 and 1024 characters' });
            }
            if (typeof bootstrapToken !== 'string' || bootstrapToken.length > 256
                || !consumeAdminBootstrapCredential(bootstrapToken)) {
                logger.warn('Admin setup attempted with an invalid or expired bootstrap credential');
                return res.status(401).json({ error: 'Invalid or expired bootstrap credential' });
            }

            // Create the account
            const account = await createAdminAccount(password);
            logger.info(`Admin account created with ID: ${account.adminId}`);

            // Issue the same short-lived opaque cookie used by normal login.
            const sessionDurationMs = 15 * 60 * 1000; // 15 minutes
            const claims = createAdminSessionClaims(account.adminId, sessionDurationMs);
            const token = adminSessionManager.storeSession(claims);
            setAdminSessionCookie(res, token);

            // CSRF remains script-readable by design; the reusable session ID
            // exists only in the HttpOnly response cookie.
            res.json({
                success: true,
                message: 'Admin account created successfully',
                adminId: account.adminId,
                csrfToken: claims.csrfToken,
                expiresIn: sessionDurationMs,
            });
        } catch (error: unknown) {
            logger.error('Admin setup failed', error);
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    /**
     * Admin login endpoint - issues an opaque admin session cookie.
     * Only available if admin account exists.
        * Localhost-only and rate-limited by dedicated admin middleware.
     */
    adminRouter.post('/auth/login', adminLoginLimiter, async (req, res) => {
        try {
            const account = await loadAdminAccount();
            if (!account) {
                return res.status(503).json({
                    error: 'Admin account not initialized. Run setup first.',
                });
            }

            // Check if account is locked
            if (isAccountLocked(account)) {
                const remainingMs = getRemainingLockoutMs(account);
                const remainingSeconds = Math.ceil(remainingMs / 1000);
                logger.warn(`Admin login attempt on locked account. Unlock in ${remainingSeconds}s`);
                return res.status(403).json({
                    error: `Account locked. Try again in ${remainingSeconds} seconds.`,
                    lockedUntilMs: remainingMs,
                });
            }

            const { password } = req.body as AdminLoginRequest;
            if (typeof password !== 'string' || password.length < 1 || password.length > 1024) {
                await recordFailedLogin(account);
                return res.status(400).json({ error: 'Password must be between 1 and 1024 characters' });
            }

            // Verify password
            const isValid = await verifyPassword(password, account.passwordHash);
            if (!isValid) {
                await recordFailedLogin(account);
                logger.warn('Admin login failed with invalid password');
                return res.status(401).json({ error: 'Invalid password' });
            }

            // Success: reset failed count and issue the browser cookie.
            await recordSuccessfulLogin(account);

            // The opaque lookup credential remains inaccessible to browser JS.
            const sessionDurationMs = 15 * 60 * 1000; // 15 minutes
            const claims = createAdminSessionClaims(account.adminId, sessionDurationMs);
            const token = adminSessionManager.storeSession(claims);
            setAdminSessionCookie(res, token);

            logger.info(`Admin ${account.adminId} logged in successfully`);

            res.json({
                success: true,
                message: 'Login successful',
                adminId: account.adminId,
                csrfToken: claims.csrfToken,
                expiresIn: sessionDurationMs,
            });
        } catch (error: unknown) {
            logger.error('Admin login failed', error);
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    /**
     * Local recovery endpoint to reset admin password and revoke all active sessions.
     * Requires a short-lived nonce issued by the loopback recovery CLI.
     */
    adminRouter.post('/auth/reset', adminLoginLimiter, requireAdminAccountExists, async (req, res) => {
        try {
            const { recoveryToken, newPassword } = req.body as {
                recoveryToken?: string;
                newPassword?: string;
            };

            if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 1024) {
                return res.status(400).json({ error: 'New password must be between 8 and 1024 characters' });
            }
            if (typeof recoveryToken !== 'string' || recoveryToken.length > 256
                || !consumeAdminRecoveryCredential(recoveryToken)) {
                logger.warn('Admin password reset attempted with an invalid or expired recovery nonce');
                return res.status(401).json({ error: 'Invalid or expired recovery nonce' });
            }

            const updatedAccount = await resetAdminPassword(newPassword);
            adminSessionManager.revokeAllForAdmin(updatedAccount.adminId);

            logger.info(
                `Admin auth reset completed by local operator for ${updatedAccount.adminId} (actorType: local-operator)`
            );

            res.json({
                success: true,
                message: 'Admin password reset complete. All active admin sessions were revoked.',
                adminId: updatedAccount.adminId,
                actorType: 'local-operator',
            });
        } catch (error: unknown) {
            logger.error('Admin password reset failed', error);
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    /**
     * POST /admin/auth/logout
     * Revoke the caller's admin session server-side. Client-side state clearing
     * alone leaves the token valid until expiry; this makes logout authoritative
     * (ADR-0029 Phase 2). Requires a valid admin session and CSRF for browser callers.
     */
    adminRouter.post(
        '/auth/logout',
        // Clear the browser cookie even when the session has just expired. The
        // request header remains available to auth/revocation for this request.
        (_req, res, next) => {
            clearAdminSessionCookie(res);
            next();
        },
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                if (req.adminSessionToken) {
                    adminSessionManager.revokeSession(req.adminSessionToken);
                    logger.info(`Admin ${req.adminSession?.adminId ?? 'unknown'} logged out (session revoked)`);
                }
                res.json({ success: true, message: 'Logged out. Session revoked.' });
            } catch (error: unknown) {
                logger.error('Admin logout failed', error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    /**
     * GET /admin/auth/me
     * Returns the authenticated admin's identity. Lets the client recover the
     * operator identity after a reload (the token alone no longer surfaces it
     * client-side) for the top-bar identity display (ADR-0030 UX-2).
     */
    adminRouter.get('/auth/me', requireAdminAccountExists, requireAdminAuth, (req, res) => {
        res.json({
            success: true,
            adminId: req.adminSession?.adminId ?? null,
            csrfToken: req.adminSession?.csrfToken ?? null,
        });
    });

    /**
     * GET /admin/auth/status
     * Check if admin account exists (used to determine setup vs login flow)
     * No auth required - public endpoint to determine app state
     */
    adminRouter.get('/auth/status', async (req, res) => {
        try {
            const account = await loadAdminAccount();
            res.json({
                success: true,
                accountExists: !!account,
            });
        } catch (error: unknown) {
            logger.error('Failed to check admin account status', error);
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });
}
