import express from 'express';
import { logger } from '@shared/utils/logger';
import { createAdminService } from '@server/services/admin/AdminService';
import { requireLocalhost } from '@server/security/policies';
import { requireAdminAuth, auditAdminAction } from '@server/middleware/requireAdminAuth';
import { requireAdminCsrf } from '@server/middleware/requireAdminCsrf';
import { createAdminLoginLimiter } from '@server/middleware/rateLimiters';
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
import { isErrorPayload } from '@server/shared/utils/isErrorPayload';
import type { AdminLoginRequest } from '@server/security/types/admin-auth.types';

interface AdminRouterDeps {
    getSystemStatusPayload: () => Promise<any>;
    /**
     * Emits a socket.io event to every connected browser client.
     * Injected from registerRoutes so the admin router doesn't hold a
     * direct reference to the io server — keeping the dependency boundary clean.
     */
    broadcastToClients: (event: string, data: unknown) => void;
}

export function createAdminRouter(deps: AdminRouterDeps) {
    // --- Admin API (Local-Only) ---
    // This API is used by the standalone CLI tool
    const adminRouter = express.Router();

    // Admin domain service: displaced operational logic for status, worlds, cache, and world actions.
    const adminService = createAdminService(deps);
    const adminLoginLimiter = createAdminLoginLimiter(getConfig());

    // Verify local request
    adminRouter.use(requireLocalhost);

    const requireAdminAccountExists = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
        try {
            const account = await loadAdminAccount();
            if (!account) {
                return res.status(503).json({
                    error: 'Admin account not initialized. Admin mutations unavailable.',
                });
            }
            next();
        } catch (error: unknown) {
            logger.error('Failed to check admin account existence', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    };

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

    // ============
    // Existing Admin Routes (guarded by account existence check + admin auth)
    // ============

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

    // Apply auth middleware to mutation endpoints
    // Order: localhost -> account exists -> admin auth -> csrf -> audit
    adminRouter.post('/setup/scrape', requireAdminAccountExists, requireAdminAuth, requireAdminCsrf, auditAdminAction);
    adminRouter.post('/world/launch', requireAdminAccountExists, requireAdminAuth, requireAdminCsrf, auditAdminAction);
    adminRouter.post('/world/shutdown', requireAdminAccountExists, requireAdminAuth, requireAdminCsrf, auditAdminAction);

    adminRouter.get('/status', async (req, res) => {
        const payload = await adminService.getStatus();
        res.json(payload);
    });

    adminRouter.get('/worlds', async (req, res) => {
        try {
            const payload = await adminService.listWorlds();
            res.json(payload);
        } catch (error) {
            logger.error('Failed to list worlds', error);
            res.status(500).json({ error: 'Failed to list worlds' });
        }
    });

    // Setup endpoints removed - functionality migrated to CLI admin tool

    adminRouter.get('/cache', async (req, res) => {
        try {
            const payload = await adminService.getCache();
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    /**
     * GET /admin/audit
     * Returns recent admin audit events (newest first).
     * Requires admin auth.
     */
    adminRouter.get('/audit', requireAdminAccountExists, requireAdminAuth, async (req, res) => {
        try {
            const limitRaw = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
            const parsedLimit = Number.parseInt(String(limitRaw ?? '100'), 10);
            const limit = Number.isFinite(parsedLimit) ? parsedLimit : 100;

            const { listAdminAuditEvents } = await import('@server/security/adminAuditLog');
            const events = await listAdminAuditEvents(limit);

            res.json({
                success: true,
                count: events.length,
                events,
            });
        } catch (error: unknown) {
            logger.error('Failed to list admin audit events', error);
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.post('/setup/scrape', async (req, res) => {
        try {
            const payload = await adminService.scrapeSetup(req.body?.sessionCookie);
            if (isErrorPayload(payload)) {
                return res.status(payload.status).json({ error: payload.error });
            }
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.post('/world/launch', async (req, res) => {
        try {
            const payload = await adminService.launchWorld(req.body?.worldId);
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.post('/world/shutdown', async (req, res) => {
        try {
            const payload = await adminService.shutdownWorld();
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    // ============
    // Module Lifecycle Endpoints
    // ============

    /**
     * GET /admin/api/lifecycle
     * List all modules with their lifecycle state (enabled/disabled, status, compatibility)
     * Requires admin auth
     */
    adminRouter.get(
        '/lifecycle',
        requireAdminAccountExists,
        requireAdminAuth,
        async (req, res) => {
            try {
                const { listModules } = await import('@modules/registry/server');
                const modules = listModules({ includeExperimental: true, includeDisabled: true });

                res.json({
                    success: true,
                    modules: modules.map((m) => {
                        return {
                            moduleId: m.info.id,
                            title: m.info.title,
                            directory: m.directory,
                            enabled: m.enabled,
                            status: m.status,
                            experimental: m.info.experimental,
                            managed: m.managed,
                            reason: m.reason,
                            health: m.lifecycle.health,
                            // Validation diagnostics from lifecycle record
                            validation: m.lifecycle.validation ? {
                                manifestValid: m.lifecycle.validation.manifestValid,
                                diagnostics: [
                                    // Map core constraint diagnostics
                                    ...(m.lifecycle.validation.coreDiagnostics || []).map(d => ({
                                        code: `core:${d.constraint}`,
                                        message: d.reason || (d.compatible ? 'Constraint satisfied' : `Constraint ${d.constraint} not satisfied`),
                                        severity: d.compatible ? 'info' : 'error',
                                    })),
                                    // Map contract diagnostics
                                    ...(m.lifecycle.validation.contractDiagnostics || []).map(d => ({
                                        code: `contract:${d.contract}`,
                                        message: d.reason || (d.compatible ? `${d.contract} ${d.providedVersion || ''} satisfies ${d.requiredRange}` : `${d.contract} incompatible`),
                                        severity: d.compatible ? 'info' : 'error',
                                    })),
                                    // Map validation errors as simple diagnostics
                                    ...(m.lifecycle.validation.validationErrors || []).map(e => ({
                                        code: 'manifest-error',
                                        message: e,
                                        severity: 'error' as const,
                                    })),
                                ],
                            } : undefined,
                            artifact: m.artifact,
                            activeSource: m.lifecycle.activeSource,
                            localDirectory: m.lifecycle.localDirectory,
                            localEnabled: m.lifecycle.localEnabled,
                            managedEnabled: m.lifecycle.managedEnabled,
                        };
                    }),
                });
            } catch (error: unknown) {
                logger.error('Failed to list module lifecycle', error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    /**
     * POST /admin/api/lifecycle/:moduleId/enable
     * Enable a module. Requires admin auth.
     * Returns 409 Conflict if dependencies are not met or conflicts exist.
     */
    adminRouter.post(
        '/lifecycle/:moduleId/enable',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const moduleId = Array.isArray(req.params.moduleId)
                    ? req.params.moduleId[0]
                    : req.params.moduleId;
                const { enableModule, checkCanEnableModule } = await import('@modules/registry/server');

                // Check dependencies and conflicts
                const depCheck = checkCanEnableModule(moduleId);
                if (!depCheck.canEnable) {
                    logger.warn(`Admin attempted to enable ${moduleId} with unmet constraints`, depCheck.violations);
                    return res.status(409).json({
                        success: false,
                        error: 'Cannot enable module due to dependency or conflict constraints',
                        violations: depCheck.violations || [],
                    });
                }

                const success = enableModule(moduleId);
                if (!success) {
                    return res.status(400).json({
                        success: false,
                        error: `Failed to enable module ${moduleId}. Module may be incompatible or invalid.`,
                    });
                }

                logger.info(`[Admin] Module enabled: ${moduleId}`);
                res.json({
                    success: true,
                    message: `Module ${moduleId} enabled`,
                    moduleId,
                });
            } catch (error: unknown) {
                logger.error(`Failed to enable module ${req.params.moduleId}`, error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    /**
     * POST /admin/api/lifecycle/:moduleId/disable
     * Disable a module. Requires admin auth.
     * Returns 409 Conflict if other modules depend on this one.
     */
    adminRouter.post(
        '/lifecycle/:moduleId/disable',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const moduleId = Array.isArray(req.params.moduleId)
                    ? req.params.moduleId[0]
                    : req.params.moduleId;
                const { disableModule, checkCanDisableModule } = await import('@modules/registry/server');
                const reason = req.body?.reason || 'Module disabled by admin';

                // Check if other modules depend on this one
                const depCheck = checkCanDisableModule(moduleId);
                if (!depCheck.canDisable) {
                    logger.warn(`Admin attempted to disable ${moduleId} with active dependents`, depCheck.violations);
                    return res.status(409).json({
                        success: false,
                        error: 'Cannot disable module because other modules depend on it',
                        violations: depCheck.violations || [],
                    });
                }

                const success = disableModule(moduleId, reason);
                if (!success) {
                    return res.status(400).json({
                        success: false,
                        error: `Failed to disable module ${moduleId}. Module may be protected (e.g., generic).`,
                    });
                }

                logger.info(`[Admin] Module disabled: ${moduleId} (reason: ${reason})`);
                res.json({
                    success: true,
                    message: `Module ${moduleId} disabled`,
                    moduleId,
                    reason,
                });
            } catch (error: unknown) {
                logger.error(`Failed to disable module ${req.params.moduleId}`, error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    /**
     * POST /admin/api/lifecycle/:moduleId/switch-source
     * Switch a module between its local dev version and managed install.
     *
     * After the registry is updated server-side, a 'moduleSourceChanged' socket
     * event is broadcast to all connected clients. Any client currently viewing
     * an actor whose system matches this moduleId will automatically re-resolve
     * and reload its module UI from the new source without a page refresh.
     */
    adminRouter.post(
        '/lifecycle/:moduleId/switch-source',
        requireAdminAccountExists, requireAdminAuth,
        async (req, res) => {
            try {
                const moduleId = String(req.params.moduleId);
                const { source } = req.body as { source?: string };
                if (source !== 'local' && source !== 'data') {
                    return res.status(400).json({ success: false, error: 'source must be "local" or "data"' });
                }
                const { switchModuleSource } = await import('@modules/registry/server');
                const result = switchModuleSource(moduleId, source);
                if (!result.success) {
                    return res.status(400).json({ success: false, error: result.error });
                }
                // Push the change to all connected clients. Clients use this to
                // invalidate their cached source-map and reload the module UI if
                // they are currently rendering an actor for this system.
                deps.broadcastToClients('moduleSourceChanged', { moduleId, source });
                res.json({ success: true, moduleId, activeSource: source });
            } catch (error: unknown) {
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    function managerErrorStatusCode(errorCode?: string): number {
        if (!errorCode) return 400;
        if (errorCode === 'module-not-found') return 404;
        if (errorCode === 'source-resolution-failed') return 422;
        if (errorCode === 'trust-policy-blocked') return 403;
        if (errorCode === 'artifact-verification-failed') return 422;
        if (errorCode === 'permission-escalation-requires-approval') return 409;
        if (errorCode === 'precondition-failed' || errorCode === 'transition-rejected') return 409;
        if (errorCode === 'validation-failed') return 422;
        return 400;
    }

    /**
     * POST /admin/api/manager/:moduleId/dry-run/install
     * Preview install impact (no mutation).
     */
    adminRouter.post(
        '/manager/:moduleId/dry-run/install',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const moduleId = Array.isArray(req.params.moduleId)
                    ? req.params.moduleId[0]
                    : req.params.moduleId;
                const source = typeof req.body?.source === 'string' ? req.body.source : `local://${moduleId}`;
                const version = typeof req.body?.version === 'string' ? req.body.version : undefined;
                const integrity = typeof req.body?.integrity === 'string' ? req.body.integrity : undefined;
                const signature = typeof req.body?.signature === 'string' ? req.body.signature : undefined;
                const permissions = typeof req.body?.permissions === 'object' ? req.body.permissions : undefined;

                const { dryRunInstallManagedModule } = await import('@modules/registry/server');
                const preview = await dryRunInstallManagedModule({
                    moduleId,
                    source,
                    version,
                    integrity,
                    signature,
                    permissions,
                });

                res.json(preview);
            } catch (error: unknown) {
                logger.error(`Failed to dry-run install for module ${req.params.moduleId}`, error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    /**
     * POST /admin/api/manager/:moduleId/dry-run/upgrade
     * Preview upgrade impact (no mutation).
     */
    adminRouter.post(
        '/manager/:moduleId/dry-run/upgrade',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const moduleId = Array.isArray(req.params.moduleId)
                    ? req.params.moduleId[0]
                    : req.params.moduleId;
                const source = typeof req.body?.source === 'string' ? req.body.source : `local://${moduleId}`;
                const targetVersion = typeof req.body?.targetVersion === 'string'
                    ? req.body.targetVersion
                    : undefined;
                const integrity = typeof req.body?.integrity === 'string' ? req.body.integrity : undefined;
                const signature = typeof req.body?.signature === 'string' ? req.body.signature : undefined;
                const permissions = typeof req.body?.permissions === 'object' ? req.body.permissions : undefined;
                const approvePermissionEscalation = req.body?.approvePermissionEscalation === true;

                const { dryRunUpgradeManagedModule } = await import('@modules/registry/server');
                const preview = await dryRunUpgradeManagedModule({
                    moduleId,
                    source,
                    targetVersion,
                    integrity,
                    signature,
                    permissions,
                    approvePermissionEscalation,
                });

                res.json(preview);
            } catch (error: unknown) {
                logger.error(`Failed to dry-run upgrade for module ${req.params.moduleId}`, error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    /**
     * POST /admin/api/manager/:moduleId/install
     * Install a discovered module and transition it through installed->validated.
     */
    adminRouter.post(
        '/manager/:moduleId/install',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const moduleId = Array.isArray(req.params.moduleId)
                    ? req.params.moduleId[0]
                    : req.params.moduleId;
                const source = typeof req.body?.source === 'string' ? req.body.source : `local://${moduleId}`;
                const version = typeof req.body?.version === 'string' ? req.body.version : undefined;
                const integrity = typeof req.body?.integrity === 'string' ? req.body.integrity : undefined;
                const signature = typeof req.body?.signature === 'string' ? req.body.signature : undefined;
                const permissions = typeof req.body?.permissions === 'object' ? req.body.permissions : undefined;

                const { installManagedModule } = await import('@modules/registry/server');
                const result = await installManagedModule({ moduleId, source, version, integrity, signature, permissions });
                if (!result.success) {
                    return res.status(managerErrorStatusCode(result.errorCode)).json({
                        success: false,
                        moduleId,
                        operation: 'install',
                        errorCode: result.errorCode,
                        error: result.error,
                        previousStatus: result.previousStatus,
                    });
                }

                res.json({
                    success: true,
                    moduleId,
                    operation: 'install',
                    previousStatus: result.previousStatus,
                    newStatus: result.newStatus,
                });
            } catch (error: unknown) {
                logger.error(`Failed to install module ${req.params.moduleId}`, error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    /**
     * POST /admin/api/manager/:moduleId/uninstall
     * Uninstall a module and remove its artifact metadata.
     */
    adminRouter.post(
        '/manager/:moduleId/uninstall',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const moduleId = Array.isArray(req.params.moduleId)
                    ? req.params.moduleId[0]
                    : req.params.moduleId;

                const { uninstallManagedModule } = await import('@modules/registry/server');
                const result = uninstallManagedModule(moduleId);
                if (!result.success) {
                    return res.status(managerErrorStatusCode(result.errorCode)).json({
                        success: false,
                        moduleId,
                        operation: 'uninstall',
                        errorCode: result.errorCode,
                        error: result.error,
                        previousStatus: result.previousStatus,
                    });
                }

                res.json({
                    success: true,
                    moduleId,
                    operation: 'uninstall',
                    previousStatus: result.previousStatus,
                    newStatus: result.newStatus,
                });
            } catch (error: unknown) {
                logger.error(`Failed to uninstall module ${req.params.moduleId}`, error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    /**
     * POST /admin/api/manager/:moduleId/upgrade
     * Upgrade a module and re-validate it under transition policy.
     */
    adminRouter.post(
        '/manager/:moduleId/upgrade',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const moduleId = Array.isArray(req.params.moduleId)
                    ? req.params.moduleId[0]
                    : req.params.moduleId;
                const source = typeof req.body?.source === 'string' ? req.body.source : `local://${moduleId}`;
                const targetVersion = typeof req.body?.targetVersion === 'string'
                    ? req.body.targetVersion
                    : undefined;
                const integrity = typeof req.body?.integrity === 'string' ? req.body.integrity : undefined;
                const signature = typeof req.body?.signature === 'string' ? req.body.signature : undefined;
                const permissions = typeof req.body?.permissions === 'object' ? req.body.permissions : undefined;
                const approvePermissionEscalation = req.body?.approvePermissionEscalation === true;

                const { upgradeManagedModule } = await import('@modules/registry/server');
                const result = await upgradeManagedModule({
                    moduleId,
                    source,
                    targetVersion,
                    integrity,
                    signature,
                    permissions,
                    approvePermissionEscalation,
                });
                if (!result.success) {
                    return res.status(managerErrorStatusCode(result.errorCode)).json({
                        success: false,
                        moduleId,
                        operation: 'upgrade',
                        errorCode: result.errorCode,
                        error: result.error,
                        previousStatus: result.previousStatus,
                    });
                }

                res.json({
                    success: true,
                    moduleId,
                    operation: 'upgrade',
                    previousStatus: result.previousStatus,
                    newStatus: result.newStatus,
                });
            } catch (error: unknown) {
                logger.error(`Failed to upgrade module ${req.params.moduleId}`, error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    /**
     * POST /admin/api/manager/:moduleId/validate
     * Re-run strict manifest+compatibility validation for a module.
     */
    adminRouter.post(
        '/manager/:moduleId/validate',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const moduleId = Array.isArray(req.params.moduleId)
                    ? req.params.moduleId[0]
                    : req.params.moduleId;

                const { validateManagedModule } = await import('@modules/registry/server');
                const result = validateManagedModule(moduleId);
                if (!result.success) {
                    return res.status(managerErrorStatusCode(result.errorCode)).json({
                        success: false,
                        moduleId,
                        operation: 'validate',
                        errorCode: result.errorCode,
                        error: result.error,
                        previousStatus: result.previousStatus,
                    });
                }

                res.json({
                    success: true,
                    moduleId,
                    operation: 'validate',
                    previousStatus: result.previousStatus,
                    newStatus: result.newStatus,
                });
            } catch (error: unknown) {
                logger.error(`Failed to validate module ${req.params.moduleId}`, error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    // Manual retry endpoint for world connection/bootstrap (admin only)
    adminRouter.post('/world/retry', requireAdminAccountExists, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const { systemService } = await import('@core/system/SystemService');
            // Only allow retry if world is closed
            const client = systemService.getSystemClient();
            if (client && (client.worldState === 'closed')) {
                await client.connect();
                // client.emit('connect');
                res.json({ success: true, message: 'Manual retry triggered. Attempting to reconnect to world.' });
            } else {
                res.status(400).json({ error: 'World is not in a closed state. Retry not allowed.' });
            }
        } catch (error: unknown) {
            logger.error('Manual world retry failed', error);
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    // ============
    // Source Profiles
    // ============

    adminRouter.get('/sources', requireAdminAccountExists, requireAdminAuth, async (req, res) => {
        try {
            const { loadSourceProfiles } = await import('@modules/registry/distribution/sourceProfiles');
            res.json({ success: true, profiles: loadSourceProfiles() });
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.post('/sources', requireAdminAccountExists, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const { createSourceProfile } = await import('@modules/registry/distribution/sourceProfiles');
            const { isHostAllowed } = await import('@modules/registry/security/sourceGovernance');
            
            const profile = req.body;
            if (!profile || !profile.baseUrl) {
                return res.status(400).json({ error: 'baseUrl is required' });
            }

            const allowlist = getConfig().security.sourceGovernance?.hostAllowlist;
            const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';
            if (!isHostAllowed(String(profile.baseUrl), allowlist, mode)) {
                return res.status(403).json({ error: 'Host is not in the configured allowlist' });
            }

            const created = createSourceProfile(profile);
            res.json({ success: true, profile: created });
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.put('/sources/:id', requireAdminAccountExists, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const { updateSourceProfile } = await import('@modules/registry/distribution/sourceProfiles');
            const { isHostAllowed } = await import('@modules/registry/security/sourceGovernance');

            const id = req.params.id as string;
            const updates = req.body;

            if (updates.baseUrl) {
                const allowlist = getConfig().security.sourceGovernance?.hostAllowlist;
                const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';
                if (!isHostAllowed(String(updates.baseUrl), allowlist, mode)) {
                    return res.status(403).json({ error: 'Host is not in the configured allowlist' });
                }
            }

            const updated = updateSourceProfile(id, updates);
            if (!updated) {
                return res.status(404).json({ error: 'Source profile not found' });
            }

            res.json({ success: true, profile: updated });
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.delete('/sources/:id', requireAdminAccountExists, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const { deleteSourceProfile } = await import('@modules/registry/distribution/sourceProfiles');
            const id = req.params.id as string;
            const deleted = deleteSourceProfile(id);
            if (!deleted) {
                return res.status(400).json({ error: 'Source profile not found or cannot be deleted' });
            }
            res.json({ success: true });
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.post('/sources/:id/test', requireAdminAccountExists, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const { getSourceProfile } = await import('@modules/registry/distribution/sourceProfiles');
            const { fetchRemoteIndex } = await import('@modules/registry/distribution/remoteIndexFetcher');
            const { isHostAllowed } = await import('@modules/registry/security/sourceGovernance');

            const id = req.params.id as string;
            const profile = getSourceProfile(id);
            if (!profile) {
                return res.status(404).json({ error: 'Source profile not found' });
            }

            if (profile.kind !== 'indexed') {
                return res.status(400).json({ error: 'Can only test connection for "indexed" source profiles' });
            }

            const allowlist = getConfig().security.sourceGovernance?.hostAllowlist;
            const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';
            if (!isHostAllowed(String(profile.baseUrl), allowlist, mode)) {
                return res.status(403).json({ error: 'Host is not in the configured allowlist' });
            }

            const result = await fetchRemoteIndex(profile.baseUrl, { auth: profile.auth });
            
            if (!result.ok) {
                return res.status(400).json({ 
                    success: false, 
                    error: result.error, 
                    errorCode: result.errorCode 
                });
            }

            const moduleCount = result.index?.modules ? Object.keys(result.index.modules).length : 0;
            res.json({ 
                success: true, 
                message: 'Connection successful',
                schemaVersion: result.index?.schemaVersion,
                publisher: result.index?.publisher,
                moduleCount
            });
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.get('/sources/:id/modules', requireAdminAccountExists, requireAdminAuth, async (req, res) => {
        try {
            const { getSourceProfile } = await import('@modules/registry/distribution/sourceProfiles');
            const { fetchRemoteIndex } = await import('@modules/registry/distribution/remoteIndexFetcher');
            const { isHostAllowed } = await import('@modules/registry/security/sourceGovernance');

            const id = req.params.id as string;
            const profile = getSourceProfile(id);
            if (!profile) {
                return res.status(404).json({ error: 'Source profile not found' });
            }

            if (profile.kind !== 'indexed') {
                return res.status(400).json({ error: 'Can only browse modules for "indexed" source profiles' });
            }

            const allowlist = getConfig().security.sourceGovernance?.hostAllowlist;
            const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';
            if (!isHostAllowed(String(profile.baseUrl), allowlist, mode)) {
                return res.status(403).json({ error: 'Host is not in the configured allowlist' });
            }

            const result = await fetchRemoteIndex(profile.baseUrl, { auth: profile.auth });
            
            if (!result.ok) {
                return res.status(400).json({ 
                    success: false, 
                    error: result.error, 
                    errorCode: result.errorCode 
                });
            }

            res.json({ 
                success: true, 
                modules: result.index?.modules || {}
            });
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    return adminRouter;
}
