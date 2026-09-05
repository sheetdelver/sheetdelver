/**
 * Admin world control endpoints: /world/launch, /world/shutdown, /world/retry.
 * Carved out of the monolithic createAdminRouter.ts per ADR-0022 Phase 4.
 */
import express from 'express';
import { logger } from '@shared/utils/logger';
import { requireAdminAuth, auditAdminAction } from '@server/middleware/requireAdminAuth';
import { requireAdminCsrf } from '@server/middleware/requireAdminCsrf';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import type { AdminServiceResult } from '@server/shared/types/admin';

export interface RegisterAdminWorldRoutesOptions {
    adminRouter: express.Router;
    adminService: AdminServiceResult;
    requireAdminAccountExists: express.RequestHandler;
}

export function registerAdminWorldRoutes(opts: RegisterAdminWorldRoutesOptions): void {
    const { adminRouter, adminService, requireAdminAccountExists } = opts;

    // Each mutation endpoint is registered once with its full middleware chain
    // inline. Order: localhost (mounted on the router upstream) -> account exists
    // -> admin auth -> csrf -> audit -> handler.
    adminRouter.post(
        '/world/launch',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const payload = await adminService.launchWorld(req.body?.worldId);
                res.json(payload);
            } catch (error: unknown) {
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    adminRouter.post(
        '/world/shutdown',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const payload = await adminService.shutdownWorld();
                res.json(payload);
            } catch (error: unknown) {
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    // Manual retry endpoint for world connection/bootstrap (admin only)
    adminRouter.post('/world/retry', requireAdminAccountExists, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const { systemService } = await import('@server/services/world');
            const { worldLifecycleStore } = await import('@server/core/world/WorldLifecycleStore');
            if (worldLifecycleStore.isState('closed')) {
                await systemService.getWorldTransportController().connect();
                res.json({ success: true, message: 'Manual retry triggered. Attempting to reconnect to world.' });
            } else {
                res.status(400).json({ error: 'World is not in a closed state. Retry not allowed.' });
            }
        } catch (error: unknown) {
            logger.error('Manual world retry failed', error);
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });
}
