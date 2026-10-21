import type express from 'express';
import { requireAdminAuth, auditAdminAction } from '@server/middleware/requireAdminAuth';
import { requireAdminCsrf } from '@server/middleware/requireAdminCsrf';
import { cleanupRetainedUpgradeFiles, createHostUpgradeCoordinator, getUpgradeJournal, installedUpgradeCandidate } from '@server/services/world/migrations/ModuleUpgradeService';
import { worldBootstrapper } from '@server/services/world/WorldBootstrapper';
import { systemService } from '@server/services/world/SystemService';
import { serviceAccountAuthority } from '@server/core/world/ServiceAccountAuthority';
import { parseModuleId } from '@shared/security/moduleId';
import { previewModuleSource, applyModuleSource } from '@server/services/world/migrations/sourceCandidates';
import { getMigrationCompatibilityDiagnostic } from '@server/services/world/migrations/installedWorldCompatibility';
import { maintenanceOnly } from '@server/core/world/MaintenanceMode';
import { upgradeReview } from '@server/services/world/migrations/upgradeReview';
import { readAdminMigrationOverview, exactMigrationStatus } from '@server/services/world/migrations/migrationAttention';

export function registerAdminUpgradeRoutes(router: express.Router, account: express.RequestHandler,
    restart: (reason: string, detail?: Record<string, unknown>) => void): void {
    router.get('/module-migrations', account, requireAdminAuth, (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try { res.json(readAdminMigrationOverview()); }
        catch { res.status(503).json({ error: 'Migration visibility unavailable. Inspect Core diagnostics; no readiness is established.' }); }
    });
    router.use('/module-upgrades', (req, res, next) => {
        if (maintenanceOnly() && req.method !== 'GET') return res.status(503).json({ error: 'Use the isolated maintenance controller for planning, approval and recovery' });
        next();
    });
    router.post('/module-upgrades/source/:moduleId/preview', account, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        const id = parseModuleId(req.params.moduleId);
        const source = req.body?.source;
        if (!id || source !== 'local' && source !== 'managed') return res.status(400).json({ error: 'Canonical module and local/managed source required' });
        try {
            if (req.body?.scopeKey) exactMigrationStatus(id, source, String(req.body.scopeKey));
            const preview = await previewModuleSource(id, source);
            if (req.body?.scopeKey) exactMigrationStatus(id, source, String(req.body.scopeKey));
            return requireAdminAuth(req, res, () => { res.json(upgradeReview(preview)); });
        }
        catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : 'Source preview unavailable' }); }
    });
    router.get('/module-upgrades/source/:moduleId/review', account, requireAdminAuth, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const id = parseModuleId(req.params.moduleId), source = req.query.source;
        if (!id || source !== 'local' && source !== 'managed' || !req.query.scopeKey) return res.status(400).json({ error: 'Exact source/world scope required' });
        try {
            const current = exactMigrationStatus(id, source, String(req.query.scopeKey));
            if (!current.previewId) throw new Error('No fresh review available. Check this source/world again.');
            const preview = await getUpgradeJournal().preview(current.previewId);
            exactMigrationStatus(id, source, String(req.query.scopeKey));
            if (preview.expiresAt <= Date.now()) throw new Error('Review expired. Check world data again.');
            return requireAdminAuth(req, res, () => { res.json(upgradeReview(preview)); });
        } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : 'Review unavailable' }); }
    });
    router.post('/module-upgrades/source/apply', account, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const job = await applyModuleSource(String(req.body?.planId ?? ''), req.adminSession!.adminId, req.body?.backupAcknowledged === true);
            res.status(202).json({ accepted: true, jobId: job.jobId, restartScheduled: job.phase === 'restarting' });
            if (job.phase === 'restarting') restart(`module-source-maintenance:${job.moduleId}`, { moduleId: job.moduleId, jobId: job.jobId });
        } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Source apply unavailable' }); }
    });
    router.get('/module-upgrades', account, requireAdminAuth, async (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try { res.json({ jobs: (await getUpgradeJournal().jobs()).map(upgradeReview), serviceAccountDiagnostic: serviceAccountAuthority.getDiagnostic(), compatibilityDiagnostic: getMigrationCompatibilityDiagnostic(), contextDiagnostic: worldBootstrapper.getContextRefreshDiagnostic(), bootstrapDiagnostic: worldBootstrapper.getBootstrapDiagnostic() }); }
        catch { res.status(503).json({ error: 'Upgrade journal is unreadable. Preserve config/module-upgrades and inspect its owner-only records before restarting.', code: 'upgrade-journal-unreadable' }); }
    });
    router.post('/module-upgrades/retry-context', account, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (_req, res) => {
        try {
            await systemService.recoverOrBootstrap();
            res.json({ accepted: true });
        } catch { res.status(409).json({ error: 'World preparation could not recover. Inspect the admin diagnostics and Core logs; no new migration approval was granted.' }); }
    });
    router.get('/module-upgrades/:id', account, requireAdminAuth, async (req, res) => {
        try { res.setHeader('Cache-Control', 'no-store'); res.json(upgradeReview((await getUpgradeJournal().job(String(req.params.id))))); }
        catch { res.status(404).json({ error: 'Upgrade job unavailable' }); }
    });
    router.post('/module-upgrades/:id/resume', account, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const job = (await getUpgradeJournal().job(String(req.params.id)));
            const candidate = installedUpgradeCandidate(job);
            // Run through normal bootstrap so fresh role/source checks and actual
            // adapter/prepared health, not a status-only modal, control activation.
            if (job.phase === 'recovery-required') {
                job.phase = 'restarting'; delete job.failure; await getUpgradeJournal().save(job);
            }
            void worldBootstrapper.bootstrap(systemService.getSystemClient()).catch(() => undefined);
            res.status(202).json({ accepted: true, jobId: job.jobId, moduleId: candidate.moduleId });
        } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Upgrade cannot resume' }); }
    });
    router.post('/module-upgrades/:id/cancel', account, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try { res.json(upgradeReview(await createHostUpgradeCoordinator().cancel(String(req.params.id)))); }
        catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Cancellation requires recovery' }); }
    });
    router.post('/module-upgrades/:id/review', account, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const job = (await getUpgradeJournal().job(String(req.params.id)));
            res.json(upgradeReview(await createHostUpgradeCoordinator().reviewRecovery(job.jobId, installedUpgradeCandidate(job))));
        } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Fresh recovery review unavailable' }); }
    });
    router.post('/module-upgrades/:id/reapprove', account, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const job = (await getUpgradeJournal().job(String(req.params.id)));
            const next = await createHostUpgradeCoordinator().reapprove(job.jobId, installedUpgradeCandidate(job), String(req.body?.planId ?? ''), req.adminSession!.adminId, req.body?.backupAcknowledged === true);
            res.status(202).json({ accepted: true, jobId: next.jobId });
            void worldBootstrapper.bootstrap(systemService.getSystemClient()).catch(() => undefined);
        } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Recovery approval unavailable' }); }
    });
    router.post('/module-upgrades/:id/cleanup', account, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try { res.json(await cleanupRetainedUpgradeFiles(String(req.params.id))); }
        catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Cleanup unavailable' }); }
    });
}
