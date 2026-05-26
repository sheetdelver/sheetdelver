/**
 * Admin router composer. Per ADR-0022 Phase 4, the per-endpoint handlers
 * live in `registerAdmin*Routes.ts` files matching the `protected/` pattern.
 * This file owns:
 *
 *  - the router instance
 *  - the `requireLocalhost` mount + `requireAdminAccountExists` middleware
 *  - the AdminService construction
 *  - the per-section register() calls (auth / status / world / module)
 */
import express from 'express';
import { logger } from '@shared/utils/logger';
import { createAdminService } from '@server/services/admin/AdminService';
import { requireLocalhost } from '@server/security/policies';
import { createAdminLoginLimiter } from '@server/middleware/rateLimiters';
import { loadAdminAccount } from '@server/security/adminCredentialStore';
import { getConfig } from '@server/core/config';
import { registerAdminAuthRoutes } from './registerAdminAuthRoutes';
import { registerAdminStatusRoutes } from './registerAdminStatusRoutes';
import { registerAdminWorldRoutes } from './registerAdminWorldRoutes';
import { registerAdminModuleRoutes } from './registerAdminModuleRoutes';

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

    // Verify local request
    adminRouter.use(requireLocalhost);

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
        broadcastToClients: deps.broadcastToClients,
    });

    return adminRouter;
}
