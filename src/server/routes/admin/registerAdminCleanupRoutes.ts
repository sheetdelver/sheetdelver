import type express from 'express';
import { requireAdminAuth, auditAdminAction } from '@server/middleware/requireAdminAuth';
import { requireAdminCsrf } from '@server/middleware/requireAdminCsrf';
import { adminSessionManager } from '@server/security/adminSessionService';
import { getOrphanTokenCleanup } from '@server/services/world/OrphanTokenCleanup';
import { withWorldWorkScope } from '@server/core/world/WorldWorkGate';

export function registerAdminCleanupRoutes(router: express.Router, account: express.RequestHandler, getCleanup = getOrphanTokenCleanup) {
    const assertAdministrator = (req: express.Request) => {
        if (!req.adminSessionToken || !adminSessionManager.getSession(req.adminSessionToken)) throw new Error('Administrator session expired. Sign in and review again.');
    };
    router.get('/world-cleanup/orphan-tokens', account, requireAdminAuth, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try { const cleanup = await getCleanup(); assertAdministrator(req); res.json({ tokens: cleanup.list() }); }
        catch { res.status(503).json({ error: 'Optional cleanup is available when the world is ready.' }); }
    });
    router.post('/world-cleanup/orphan-tokens/delete', account, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const cleanup = await getCleanup();
            res.json(await withWorldWorkScope(() => Array.isArray(req.body?.tokens)
                ? cleanup.removeSelected(req.body, () => assertAdministrator(req))
                : cleanup.remove(req.body, () => assertAdministrator(req))));
        } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Cleanup could not be confirmed. Refresh before taking another action.' }); }
    });
}
