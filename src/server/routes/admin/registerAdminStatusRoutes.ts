/**
 * Admin status/listing endpoints: /status, /worlds, /cache, /audit. Carved
 * out of the monolithic createAdminRouter.ts per ADR-0022 Phase 4.
 */
import express from 'express';
import { logger } from '@shared/utils/logger';
import { requireAdminAuth } from '@server/middleware/requireAdminAuth';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import type { AdminServiceResult } from '@server/shared/types/admin';

export interface RegisterAdminStatusRoutesOptions {
    adminRouter: express.Router;
    adminService: AdminServiceResult;
    requireAdminAccountExists: express.RequestHandler;
}

export function registerAdminStatusRoutes(opts: RegisterAdminStatusRoutesOptions): void {
    const { adminRouter, adminService, requireAdminAccountExists } = opts;

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
}
