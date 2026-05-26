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
import { getConfig } from '@server/core/config';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import type { AdminLoginRequest } from '@server/security/types/admin-auth.types';

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
     * Requires one-time setup token from config/env.
     * Localhost-only.
     */
    adminRouter.post('/auth/setup', async (req, res) => {
        try {
            const existingAccount = await loadAdminAccount();
            if (existingAccount) {
                return res.status(403).json({ error: 'Admin account already exists' });
            }

            const config = getConfig();
            const setupToken = config.security.adminSetupToken;
            if (!setupToken) {
                return res.status(503).json({
                    error: 'Bootstrap not configured. Set APP_ADMIN_SETUP_TOKEN environment variable.',
                });
            }

            const { setupToken: clientToken, password } = req.body as {
                setupToken?: string;
                password?: string;
            };

            // Verify setup token
            if (clientToken !== setupToken) {
                logger.warn('Admin setup attempted with invalid setup token');
                return res.status(401).json({ error: 'Invalid setup token' });
            }

            // Validate password
            if (!password || typeof password !== 'string' || password.length < 8) {
                return res.status(400).json({ error: 'Password must be at least 8 characters' });
            }

            // Create the account
            const account = await createAdminAccount(password);
            logger.info(`Admin account created with ID: ${account.adminId}`);

            // Issue admin session token (same as login)
            const sessionDurationMs = 15 * 60 * 1000; // 15 minutes
            const claims = createAdminSessionClaims(account.adminId, sessionDurationMs);
            const token = adminSessionManager.storeSession(claims);

            // Return token so user is immediately authenticated
            res.json({
                success: true,
                message: 'Admin account created successfully',
                adminId: account.adminId,
                token,
                csrfToken: claims.csrfToken,
                expiresIn: sessionDurationMs,
            });
        } catch (error: unknown) {
            logger.error('Admin setup failed', error);
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    /**
     * Admin login endpoint - issues admin session token.
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
            if (!password) {
                await recordFailedLogin(account);
                return res.status(400).json({ error: 'Password required' });
            }

            // Verify password
            const isValid = await verifyPassword(password, account.passwordHash);
            if (!isValid) {
                await recordFailedLogin(account);
                logger.warn('Admin login failed with invalid password');
                return res.status(401).json({ error: 'Invalid password' });
            }

            // Success: reset failed count and issue token
            await recordSuccessfulLogin(account);

            // Issue short-lived admin session token (15 minutes)
            const sessionDurationMs = 15 * 60 * 1000; // 15 minutes
            const claims = createAdminSessionClaims(account.adminId, sessionDurationMs);
            const token = adminSessionManager.storeSession(claims);

            logger.info(`Admin ${account.adminId} logged in successfully`);

            res.json({
                success: true,
                message: 'Login successful',
                adminId: account.adminId,
                token,
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
     * Requires the configured bootstrap/reset token and a new password.
     */
    adminRouter.post('/auth/reset', requireAdminAccountExists, async (req, res) => {
        try {
            const config = getConfig();
            const setupToken = config.security.adminSetupToken;
            if (!setupToken) {
                return res.status(503).json({
                    error: 'Reset not configured. Set APP_ADMIN_SETUP_TOKEN environment variable.',
                });
            }

            const { setupToken: clientToken, newPassword } = req.body as {
                setupToken?: string;
                newPassword?: string;
            };

            if (clientToken !== setupToken) {
                logger.warn('Admin password reset attempted with invalid setup token');
                return res.status(401).json({ error: 'Invalid setup token' });
            }

            if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
                return res.status(400).json({ error: 'New password must be at least 8 characters' });
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
