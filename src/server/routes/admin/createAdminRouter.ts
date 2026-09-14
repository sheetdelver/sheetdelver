/**
 * Admin router composer. Per ADR-0022 Phase 4, the per-endpoint handlers
 * live in `registerAdmin*Routes.ts` files matching the `protected/` pattern.
 * This file owns:
 *
 *  - the router instance
 *  - the network/origin mounts plus `requireAdminAccountExists` middleware
 *  - the AdminService construction
 *  - the per-section register() calls (auth / status / world / module)
 */
import express from 'express';
import { logger } from '@shared/utils/logger';
import { createAdminService } from '@server/services/admin/AdminService';
import { requireAdminNetwork, requireAdminOrigin } from '@server/security/policies';
import { createAdminLoginLimiter } from '@server/middleware/rateLimiters';
import { loadAdminAccount } from '@server/security/adminCredentialStore';
import { getConfig } from '@server/core/config';
import { registerAdminAuthRoutes } from './registerAdminAuthRoutes';
import { registerAdminStatusRoutes } from './registerAdminStatusRoutes';
import { registerAdminWorldRoutes } from './registerAdminWorldRoutes';
import { registerAdminModuleRoutes } from './registerAdminModuleRoutes';
import { adminSessionManager } from '@server/security/adminSessionService';
import { worldBootstrapper } from '@server/services/world';
import { requestFullStackRestart } from '@shared/runtime/fullStackRestart';

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
    // This API is consumed by the Admin UI
    const adminRouter = express.Router();

    // Admin domain service: displaced operational logic for status, worlds, cache, and world actions.
    const adminService = createAdminService(deps);
    const adminLoginLimiter = createAdminLoginLimiter(getConfig());
    let restartScheduled = false;
    const requestServerRestart = (reason: string, detail: Record<string, unknown> = {}) => {
        if (restartScheduled) return;
        restartScheduled = true;
        try {
            adminSessionManager.prepareSupervisedRestartHandoff();
        } catch (error) {
            // Runtime replacement remains authoritative even if admin continuity
            // cannot be prepared. The operator can authenticate again afterward.
            logger.warn('Admin | Could not prepare supervised-restart session handoff', error);
        }
        worldBootstrapper.reset(reason);
        deps.broadcastToClients('serverRestarting', { reason, ...detail });
        setTimeout(() => {
            logger.info(`Admin | ${reason} - signalling manager for full-stack restart`);
            requestFullStackRestart();
        }, 500);
    };

    // Verify local request
    adminRouter.use(requireAdminNetwork);
    adminRouter.use(requireAdminOrigin);

    const requireAdminAccountExists: express.RequestHandler = async (req, res, next) => {
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

    registerAdminAuthRoutes({
        adminRouter,
        adminLoginLimiter,
        requireAdminAccountExists,
    });

    registerAdminStatusRoutes({
        adminRouter,
        adminService,
        requireAdminAccountExists,
    });

    registerAdminWorldRoutes({
        adminRouter,
        adminService,
        requireAdminAccountExists,
    });

    registerAdminModuleRoutes({
        adminRouter,
        requireAdminAccountExists,
        requestServerRestart,
    });

    return adminRouter;
}
