import { randomUUID } from 'node:crypto';
import { readMaintenanceMode, saveMaintenanceMode, maintenanceOnly, assertMaintenanceDrained, setMaintenanceComputationSignal, type MaintenanceMode } from '@server/core/world/MaintenanceMode';
import { worldWorkGate } from '@server/core/world/WorldWorkGate';
import { getUpgradeJournal, createHostUpgradeCoordinator, installedUpgradeCandidate } from './ModuleUpgradeService';
import { migrationDirectoryDigest } from '@modules/registry/migrations/catalog';
import { applyModuleSource } from './sourceCandidates';
import { migrationReason } from './planner';
import type { UpgradeCandidate } from './ModuleUpgradeCoordinator';
import type { CoreSocket } from '@server/core/foundry/sockets/CoreSocket';
import { refreshRegistry } from '@modules/registry/server';
import { prepareIsolated } from './prepareIsolated';
import { upgradeReview } from './upgradeReview';
import { reconcileMaintenanceApproval } from './firstApproval';

let shutdownNormal: (() => Promise<void>) | undefined;
export function setNormalMaintenanceShutdown(stop: () => Promise<void>): void { shutdownNormal = stop; }

/** Disruption consent only. No native writes or approval are created here. */
export async function enterMaintenance(planId: string): Promise<MaintenanceMode> {
    if (maintenanceOnly()) throw new Error('A persistent maintenance operation already owns this runtime');
    const journal = getUpgradeJournal(); const preview = (await journal.preview(planId));
    const candidate = (await journal.sourceCandidate(planId));
    if (migrationDirectoryDigest(candidate.root) !== preview.treeDigest) throw new Error('Advisory candidate changed; inspect it again');
    const mode: MaintenanceMode = { schemaVersion: 1, id: randomUUID(), stage: 'entering', moduleId: candidate.moduleId,
        candidateId: planId, world: preview.plan.world.identity, drained: worldWorkGate.pendingDispatches() === 0, updatedAt: Date.now() };
    mode.leaseToken = journal.acquire({ jobId: mode.id, moduleId: mode.moduleId, plan: preview.plan });
    saveMaintenanceMode(mode); // fsync precedes closing/stopping any worker
    worldWorkGate.block('persistent-maintenance', { phase: 'entering', message: 'Module upgrade in progress' });
    return mode;
}
export async function drainNormalRuntime(): Promise<void> {
    try { await worldWorkGate.drain(); await getUpgradeJournal().drain(); const mode = readMaintenanceMode()!; mode.drained = true; saveMaintenanceMode(mode); await shutdownNormal?.(); await getUpgradeJournal().close(); }
    catch (error) {
        const mode = readMaintenanceMode()!; mode.stage = 'recovery-required';
        mode.failure = migrationReason(error); saveMaintenanceMode(mode);
        throw error;
    }
}

/** A process-owned controller: HTTP disconnects never cancel its work. */
export class MaintenanceController {
    private busy = false;
    private cancelling = false;
    private abort?: AbortController;
    private pending?: Promise<void>;
    constructor(private readonly transport: CoreSocket, private readonly restart: () => void) {}
    async candidate(): Promise<UpgradeCandidate> {
        const mode = readMaintenanceMode()!;
        return mode.candidateId ? (await getUpgradeJournal().sourceCandidate(mode.candidateId))
            : installedUpgradeCandidate((await getUpgradeJournal().job(mode.jobId!)));
    }
    status() {
        const mode = readMaintenanceMode();
        let preview;
        if (mode?.previewId && ['review', 'recovery-required'].includes(mode.stage)) preview = getUpgradeJournal().peekPreview(mode.previewId);
        return { mode, preview, busy: this.busy || this.cancelling };
    }
    async plan(): Promise<void> {
        return this.work(async mode => {
            assertMaintenanceDrained(mode);
            const candidate = await this.candidate();
            if (mode.jobId && (await getUpgradeJournal().job(mode.jobId)).phase !== 'recovery-required') throw new Error('Approved job must resume, not silently replan');
            mode.stage = 'planning'; delete mode.failure; saveMaintenanceMode(mode);
            const preview = mode.jobId ? await createHostUpgradeCoordinator().reviewRecovery(mode.jobId, candidate)
                : await createHostUpgradeCoordinator().preview(candidate);
            await getUpgradeJournal().saveSourceCandidate(preview.id, candidate);
            mode = readMaintenanceMode()!; mode.previewId = preview.id; mode.stage = 'review'; saveMaintenanceMode(mode);
        });
    }
    async approve(planId: string, administrator: string, backupAcknowledged: boolean): Promise<void> {
        return this.work(async mode => {
            assertMaintenanceDrained(mode);
            if (mode.stage !== 'review' || mode.previewId !== planId) throw new Error('Exact authoritative maintenance plan required');
            mode.stage = 'executing'; delete mode.failure; saveMaintenanceMode(mode);
            if (mode.jobId) {
                await createHostUpgradeCoordinator().reapprove(mode.jobId, await this.candidate(), planId, administrator, backupAcknowledged);
            } else {
                const candidate = await this.candidate();
                if (candidate.archive) {
                    const { applyLocalModuleArchive } = await import('@modules/registry/core/archiveOperations');
                    const result = await applyLocalModuleArchive(candidate.archive.operation, { ...candidate.archive.input, planId,
                        idempotencyKey: mode.id, administrator, backupAcknowledged });
                    if (!result.success || !result.jobId) throw new Error(result.error || 'Archive promotion did not create the reviewed job');
                } else await applyModuleSource(planId, administrator, backupAcknowledged);
            }
            await this.execute();
        });
    }
    async resume(): Promise<void> {
        return this.work(async mode => {
            assertMaintenanceDrained(mode);
            if (!mode.jobId) throw new Error('No approved job exists; complete authoritative planning and review first');
            const job = (await getUpgradeJournal().job(mode.jobId));
            if (job.phase === 'recovery-required') { job.phase = 'restarting'; delete job.failure; await getUpgradeJournal().save(job); }
            mode.stage = 'executing'; delete mode.failure; saveMaintenanceMode(mode);
            await this.execute();
        });
    }
    async cancel(): Promise<void> {
        if (this.cancelling) throw new Error('Maintenance cancellation is already active');
        // Check before cancelling jobs, releasing leases or scheduling startup.
        // A diagnostic string is never proof that ordinary sends settled.
        const current = readMaintenanceMode();
        if (!current) throw new Error('Persistent maintenance operation required');
        try { assertMaintenanceDrained(current); }
        catch (error) { current.stage = 'recovery-required'; current.failure = migrationReason(error); saveMaintenanceMode(current); throw error; }
        this.cancelling = true;
        try {
        this.abort?.abort(new Error('Maintenance scheduling stopped by administrator'));
        await this.pending?.catch(() => undefined);
        await reconcileMaintenanceApproval(getUpgradeJournal());
        const mode = readMaintenanceMode()!;
        if (mode.id !== current.id) throw new Error('Maintenance operation changed during cancellation');
        assertMaintenanceDrained(mode);
        if (mode.jobId) {
            const stopped = await createHostUpgradeCoordinator().cancel(mode.jobId);
            if (stopped.possibleWrite) { mode.stage = 'recovery-required'; mode.failure = 'Scheduling stopped. Possible writes require readback and reviewed recovery; no world undo was performed.'; saveMaintenanceMode(mode); return; }
        } else {
            const preview = (await getUpgradeJournal().preview(mode.candidateId!));
            const lease = { jobId: mode.id, moduleId: mode.moduleId, plan: preview.plan, leaseToken: mode.leaseToken ?? '' };
            try { getUpgradeJournal().assertLease(lease); }
            catch { lease.leaseToken = getUpgradeJournal().acquire(lease); mode.leaseToken = lease.leaseToken; saveMaintenanceMode(mode); }
            getUpgradeJournal().release(lease);
        }
        mode.stage = 'activating'; delete mode.failure; saveMaintenanceMode(mode);
        this.restart(); // normal bootstrap still validates the restored source before reopening
        } catch (error) {
            const mode = readMaintenanceMode();
            if (mode?.id === current.id && !mode.diagnosticOnly) { mode.stage = 'recovery-required'; mode.failure = migrationReason(error); saveMaintenanceMode(mode); }
            throw error;
        } finally { this.cancelling = false; }
    }
    private async execute(): Promise<void> {
        refreshRegistry(); // metadata selection only; no normal user/module routes
        // The production compatibility/controller path performs execution, full
        // readback and fresh preparation. Persistent maintenance still gates all
        // ordinary work; no normal transport controller/gateway is running.
        const selected = readMaintenanceMode()!;
        if (!selected.jobId) throw new Error('Approved job required');
        await createHostUpgradeCoordinator({ prepare: async () => prepareIsolated(this.transport) }).resume(selected.jobId, installedUpgradeCandidate((await getUpgradeJournal().job(selected.jobId))));
        const mode = readMaintenanceMode()!;
        if (!mode.jobId || (await getUpgradeJournal().job(mode.jobId)).phase !== 'completed') throw new Error('Complete verified preparation required before activation');
        mode.stage = 'activating'; delete mode.failure; saveMaintenanceMode(mode);
        this.restart();
    }
    private work(operation: (mode: MaintenanceMode) => Promise<void>): Promise<void> {
        if (this.busy || this.cancelling) return Promise.reject(new Error('Maintenance controller is already active'));
        const mode = readMaintenanceMode(); if (!mode || !maintenanceOnly(mode)) return Promise.reject(new Error('Isolated maintenance runtime required'));
        this.busy = true;
        this.abort = new AbortController(); setMaintenanceComputationSignal(this.abort.signal);
        this.pending = (async () => {
            try { await reconcileMaintenanceApproval(getUpgradeJournal()); await operation(readMaintenanceMode()!); }
            catch (error) { const current = readMaintenanceMode()!; current.stage = 'recovery-required'; current.failure = migrationReason(error); saveMaintenanceMode(current); throw error; }
            finally { this.busy = false; setMaintenanceComputationSignal(); }
        })();
        return this.pending;
    }
}

let controller: MaintenanceController | undefined;
export function installMaintenanceController(value: MaintenanceController): void { controller = value; }
export function getMaintenanceController(): MaintenanceController {
    if (!controller) throw new Error('Maintenance-only controller is unavailable; wait for supervised replacement');
    return controller;
}
