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

let shutdownNormal: (() => Promise<void>) | undefined;
export function setNormalMaintenanceShutdown(stop: () => Promise<void>): void { shutdownNormal = stop; }

/** Disruption consent only. No native writes or approval are created here. */
export async function enterMaintenance(planId: string): Promise<MaintenanceMode> {
    if (maintenanceOnly()) throw new Error('A persistent maintenance operation already owns this runtime');
    const journal = getUpgradeJournal(); const preview = journal.preview(planId);
    const candidate = journal.sourceCandidate(planId);
    if (migrationDirectoryDigest(candidate.root) !== preview.treeDigest) throw new Error('Advisory candidate changed; inspect it again');
    const mode: MaintenanceMode = { schemaVersion: 1, id: randomUUID(), stage: 'entering', moduleId: candidate.moduleId,
        candidateId: planId, world: preview.plan.world.identity, drained: worldWorkGate.pendingDispatches() === 0, updatedAt: Date.now() };
    mode.leaseToken = journal.acquire({ jobId: mode.id, moduleId: mode.moduleId, plan: preview.plan });
    saveMaintenanceMode(mode); // fsync precedes closing/stopping any worker
    worldWorkGate.block('persistent-maintenance', { phase: 'entering', message: 'Module upgrade in progress' });
    return mode;
}
export async function drainNormalRuntime(): Promise<void> {
    try { await worldWorkGate.drain(); const mode = readMaintenanceMode()!; mode.drained = true; saveMaintenanceMode(mode); await shutdownNormal?.(); }
    catch (error) {
        const mode = readMaintenanceMode()!; mode.stage = 'recovery-required';
        mode.failure = migrationReason(error); saveMaintenanceMode(mode);
        throw error;
    }
}

/** A process-owned controller: HTTP disconnects never cancel its work. */
export class MaintenanceController {
    private busy = false;
    private abort?: AbortController;
    private pending?: Promise<void>;
    constructor(private readonly transport: CoreSocket, private readonly restart: () => void) {}
    candidate(): UpgradeCandidate {
        const mode = readMaintenanceMode()!;
        return mode.candidateId ? getUpgradeJournal().sourceCandidate(mode.candidateId)
            : installedUpgradeCandidate(getUpgradeJournal().job(mode.jobId!));
    }
    status() {
        const mode = readMaintenanceMode();
        let preview;
        if (mode?.previewId && ['review', 'recovery-required'].includes(mode.stage)) preview = upgradeReview(getUpgradeJournal().preview(mode.previewId));
        return { mode, preview, busy: this.busy };
    }
    async plan(): Promise<void> {
        return this.work(async mode => {
            assertMaintenanceDrained(mode);
            const candidate = this.candidate();
            if (mode.jobId && getUpgradeJournal().job(mode.jobId).phase !== 'recovery-required') throw new Error('Approved job must resume, not silently replan');
            mode.stage = 'planning'; delete mode.failure; saveMaintenanceMode(mode);
            const preview = mode.jobId ? await createHostUpgradeCoordinator().reviewRecovery(mode.jobId, candidate)
                : await createHostUpgradeCoordinator().preview(candidate);
            getUpgradeJournal().saveSourceCandidate(preview.id, candidate);
            mode = readMaintenanceMode()!; mode.previewId = preview.id; mode.stage = 'review'; saveMaintenanceMode(mode);
        });
    }
    async approve(planId: string, administrator: string, backupAcknowledged: boolean): Promise<void> {
        return this.work(async mode => {
            assertMaintenanceDrained(mode);
            if (mode.stage !== 'review' || mode.previewId !== planId) throw new Error('Exact authoritative maintenance plan required');
            mode.stage = 'executing'; delete mode.failure; saveMaintenanceMode(mode);
            if (mode.jobId) {
                await createHostUpgradeCoordinator().reapprove(mode.jobId, this.candidate(), planId, administrator, backupAcknowledged);
            } else {
                const candidate = this.candidate();
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
            const job = getUpgradeJournal().job(mode.jobId);
            if (job.phase === 'recovery-required') { job.phase = 'restarting'; delete job.failure; getUpgradeJournal().save(job); }
            mode.stage = 'executing'; delete mode.failure; saveMaintenanceMode(mode);
            await this.execute();
        });
    }
    async cancel(): Promise<void> {
        // Check before cancelling jobs, releasing leases or scheduling startup.
        // A diagnostic string is never proof that ordinary sends settled.
        const current = readMaintenanceMode();
        if (!current) throw new Error('Persistent maintenance operation required');
        try { assertMaintenanceDrained(current); }
        catch (error) { current.stage = 'recovery-required'; current.failure = migrationReason(error); saveMaintenanceMode(current); throw error; }
        this.abort?.abort(new Error('Maintenance scheduling stopped by administrator'));
        await this.pending?.catch(() => undefined);
        const mode = readMaintenanceMode()!;
        assertMaintenanceDrained(mode);
        if (mode.jobId) {
            const stopped = await createHostUpgradeCoordinator().cancel(mode.jobId);
            if (stopped.possibleWrite) { mode.stage = 'recovery-required'; mode.failure = 'Scheduling stopped. Possible writes require readback and reviewed recovery; no world undo was performed.'; saveMaintenanceMode(mode); return; }
        } else {
            const preview = getUpgradeJournal().preview(mode.candidateId!);
            getUpgradeJournal().release({ jobId: mode.id, moduleId: mode.moduleId, plan: preview.plan, leaseToken: mode.leaseToken! });
        }
        mode.stage = 'activating'; delete mode.failure; saveMaintenanceMode(mode);
        this.restart(); // normal bootstrap still validates the restored source before reopening
    }
    private async execute(): Promise<void> {
        refreshRegistry(); // metadata selection only; no normal user/module routes
        // The production compatibility/controller path performs execution, full
        // readback and fresh preparation. Persistent maintenance still gates all
        // ordinary work; no normal transport controller/gateway is running.
        const selected = readMaintenanceMode()!;
        if (!selected.jobId) throw new Error('Approved job required');
        await createHostUpgradeCoordinator({ prepare: async () => prepareIsolated(this.transport) }).resume(selected.jobId, installedUpgradeCandidate(getUpgradeJournal().job(selected.jobId)));
        const mode = readMaintenanceMode()!;
        if (!mode.jobId || getUpgradeJournal().job(mode.jobId).phase !== 'completed') throw new Error('Complete verified preparation required before activation');
        mode.stage = 'activating'; delete mode.failure; saveMaintenanceMode(mode);
        this.restart();
    }
    private work(operation: (mode: MaintenanceMode) => Promise<void>): Promise<void> {
        if (this.busy) return Promise.reject(new Error('Maintenance controller is already active'));
        const mode = readMaintenanceMode(); if (!mode || !maintenanceOnly(mode)) return Promise.reject(new Error('Isolated maintenance runtime required'));
        this.busy = true;
        this.abort = new AbortController(); setMaintenanceComputationSignal(this.abort.signal);
        this.pending = (async () => {
            try { await operation(mode); }
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
