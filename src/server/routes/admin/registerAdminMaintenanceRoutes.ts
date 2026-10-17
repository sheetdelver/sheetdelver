import type express from 'express';
import { requireAdminAuth, auditAdminAction } from '@server/middleware/requireAdminAuth';
import { requireAdminCsrf } from '@server/middleware/requireAdminCsrf';
import { readMaintenanceMode, maintenanceOnly } from '@server/core/world/MaintenanceMode';
import { drainNormalRuntime, enterMaintenance, getMaintenanceController } from '@server/services/world/migrations/MaintenanceController';
import { migrationReason } from '@server/services/world/migrations/planner';
import { maintenanceMigrationStatus } from '@server/services/world/migrations/migrationAttention';

export function registerAdminMaintenanceRoutes(router: express.Router, account: express.RequestHandler, restart: (reason: string) => void): void {
    router.get('/module-maintenance', account, requireAdminAuth, (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try { res.json({ ...(maintenanceOnly() ? getMaintenanceController().status() : { mode: readMaintenanceMode() }), migration: maintenanceMigrationStatus() }); }
        catch (error) { res.json({ mode: readMaintenanceMode(), failure: migrationReason(error) }); }
    });
    router.post('/module-maintenance/enter', account, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const mode = await enterMaintenance(String(req.body?.planId ?? ''));
            res.status(202).json({ accepted: true, operationId: mode.id, writesAuthorized: false });
            void drainNormalRuntime().finally(() => restart('enter-isolated-maintenance')).catch(() => undefined);
        } catch (error) { res.status(409).json({ error: migrationReason(error) }); }
    });
    for (const action of ['plan', 'approve', 'resume', 'cancel'] as const) {
        router.post(`/module-maintenance/${action}`, account, requireAdminAuth, requireAdminCsrf, auditAdminAction, (req, res) => {
            try {
                const controller = getMaintenanceController();
                const current = controller.status();
                if (current.busy && action !== 'cancel') return res.status(409).json({ error: 'Maintenance controller is already active' });
                if (action === 'approve' && req.body?.backupAcknowledged !== true) return res.status(400).json({ error: 'Foundry backup / no SheetDelver undo acknowledgement required' });
                if (action === 'approve' && (current.mode?.stage !== 'review' || current.mode.previewId !== req.body?.planId)) return res.status(409).json({ error: 'Exact authoritative maintenance plan required' });
                if (action === 'resume' && !current.mode?.jobId) return res.status(409).json({ error: 'No approved job exists' });
                const task = action === 'approve' ? controller.approve(String(req.body?.planId ?? ''), req.adminSession!.adminId, req.body?.backupAcknowledged === true)
                    : action === 'resume' ? controller.resume() : action === 'cancel' ? controller.cancel() : controller.plan();
                res.status(202).json({ accepted: true });
                void task.catch(() => undefined); // durable status records failure; no unhandled promise
            } catch (error) { res.status(409).json({ error: migrationReason(error) }); }
        });
    }
}
