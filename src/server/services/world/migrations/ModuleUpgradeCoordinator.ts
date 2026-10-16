import { randomUUID } from 'node:crypto';
import { canonicalJson, discoverMigrations, migrationDirectoryDigest, type ResolvedMigrationCatalog } from '@modules/registry/migrations/catalog';
import type { SystemModuleInfo } from '@modules/registry/core/types';
import type { ModuleWorldSnapshot } from '@shared/sdk/world';
import type { MigrationTarget } from '@shared/sdk/migrations';
import { WorldWorkGate } from '@server/core/world/WorldWorkGate';
import { UpgradeJournal, type UpgradeJob, type UpgradePreview, type UpgradePhase } from './UpgradeJournal';
import { applyMigrationPatch, hookInput, planWorldMigrations, sourceHash, targetSourceHash } from './planner';
import { runMigrationHook } from './hooks';

export interface UpgradeCandidate {
    moduleId: string; version: string; artifactDigest: string; root: string; info: SystemModuleInfo;
    sourceDirectory?: string; sourceDigest?: string; sourceCategory?: 'local' | 'managed';
}
export interface UpgradeSourceSnapshot { world: Readonly<ModuleWorldSnapshot>; targets: MigrationTarget[]; exclusions?: string[] }
export interface UpgradeCoordinatorDeps {
    journal: UpgradeJournal;
    gate: WorldWorkGate;
    /** Fresh source, without candidate adapter initialization or user readiness. */
    snapshot(catalog: ResolvedMigrationCatalog): Promise<UpgradeSourceSnapshot>;
    assertAuthority(): void;
    write(target: MigrationTarget, updates: Record<string, unknown>, fence: () => void): Promise<void>;
    promote(job: UpgradeJob): Promise<void>;
    restart(job: UpgradeJob): void;
    prepare(job: UpgradeJob): Promise<void>;
    activate(job: UpgradeJob): Promise<void>;
    rollbackFiles(job: UpgradeJob): Promise<void>;
    now?: () => number;
}
// Admin requests construct short-lived coordinators. The local busy guard must
// span those instances in addition to the durable cross-process lease.
const runningJobs = new Set<string>();

/** Admin-approved single-writer state machine. No module runtime can call this. */
export class ModuleUpgradeCoordinator {
    private readonly now: () => number;
    private readonly running = runningJobs;
    constructor(private readonly deps: UpgradeCoordinatorDeps) { this.now = deps.now ?? Date.now; }
    restoreGate(): void {
        for (const job of this.deps.journal.jobs()) if (!['completed', 'cancelled'].includes(job.phase)) this.gate(job.phase);
    }
    async preview(candidate: UpgradeCandidate): Promise<UpgradePreview> {
        const catalog = discoverMigrations(candidate.root, candidate.info);
        if (!catalog) throw new Error('Candidate has no migration catalog');
        for (const job of this.deps.journal.jobs().filter(job => job.moduleId === candidate.moduleId && job.possibleWrite)) {
            for (const [id, digest] of Object.entries(job.stepDigests)) {
                if (catalog.steps.find(step => step.id === id)?.digest !== digest) throw new Error('Historical migration step removed or changed; use a new stable step ID');
            }
        }
        this.deps.assertAuthority();
        const source = await this.deps.snapshot(catalog);
        this.deps.assertAuthority();
        if (source.world.identity.systemId !== candidate.moduleId && !candidate.info.aliases?.includes(source.world.identity.systemId)) throw new Error('Wrong world/system for migration preview');
        const plan = planWorldMigrations(candidate.root, catalog, source.world, source.targets, false, source.exclusions);
        const preview: UpgradePreview = { id: randomUUID(), moduleId: candidate.moduleId, artifactDigest: candidate.artifactDigest,
            treeDigest: migrationDirectoryDigest(candidate.root),
            stepDigests: Object.fromEntries(catalog.steps.map(step => [step.id, step.digest])),
            candidateVersion: candidate.version, catalogDigest: catalog.digest, expiresAt: this.now() + 15 * 60_000, plan };
        this.deps.journal.savePreview(preview);
        return preview;
    }
    async approve(candidate: UpgradeCandidate, approval: { planId: string; idempotencyKey: string; backupAcknowledged: boolean; administrator: string }): Promise<UpgradeJob> {
        if (!approval.backupAcknowledged) throw new Error('Foundry backup / no SheetDelver undo warning acknowledgement required');
        if (!/^[a-zA-Z0-9-]{8,128}$/.test(approval.idempotencyKey) || !approval.administrator) throw new Error('Invalid admin approval');
        const existing = this.deps.journal.jobs().find(job => job.idempotencyKey === approval.idempotencyKey);
        if (existing) {
            if (existing.id !== approval.planId || existing.artifactDigest !== candidate.artifactDigest) throw new Error('Idempotency key is bound to another approval');
            return existing;
        }
        const preview = this.deps.journal.preview(approval.planId);
        if (preview.recoveryJobId) throw new Error('Recovery preview requires explicit reapproval of the existing job');
        if (this.deps.journal.jobs().some(job => !['completed', 'cancelled'].includes(job.phase)
            && (job.moduleId === candidate.moduleId || this.deps.journal.leaseKey(job) === this.deps.journal.leaseKey(preview)))) throw new Error('Another approved job owns the world/module lease');
        const catalog = discoverMigrations(candidate.root, candidate.info);
        if (!catalog || preview.expiresAt < this.now() || preview.artifactDigest !== candidate.artifactDigest
            || preview.moduleId !== candidate.moduleId || preview.candidateVersion !== candidate.version || preview.catalogDigest !== catalog.digest
            || preview.treeDigest !== migrationDirectoryDigest(candidate.root)
            || preview.plan.blockers.length) throw new Error('Upgrade preview is blocked, stale or changed');
        const job: UpgradeJob = { ...preview, jobId: randomUUID(), administrator: approval.administrator, idempotencyKey: approval.idempotencyKey,
            phase: 'quiescing', backupAcknowledged: true, backupWarningRevision: 1, leaseToken: '', candidateRoot: candidate.root,
            outcomes: {}, possibleWrite: false, sourceDirectory: candidate.sourceDirectory, sourceDigest: candidate.sourceDigest,
            sourceCategory: candidate.sourceCategory, worldDataStatus: 'unverified' };
        // Persist the gate BEFORE file replacement; process startup loads it before registry/adapter imports.
        // Acquire before publishing a pending job. A losing tab must not leave
        // an orphan maintenance record which can never own the existing lease.
        job.leaseToken = this.deps.journal.acquire(job);
        try { this.deps.journal.save(job); }
        catch (error) { this.deps.journal.release(job); throw error; }
        this.gate('quiescing');
        try {
            await this.deps.gate.drain();
            const source = await this.deps.snapshot(catalog);
            this.fence(job);
            const current = planWorldMigrations(candidate.root, catalog, source.world, source.targets, false, source.exclusions);
            if (current.digest !== preview.plan.digest) throw new Error('World plan changed; rerun preview');
            this.phase(job, 'installing');
            await this.deps.promote(job);
            job.installedVersion = job.candidateVersion;
            this.fence(job);
            this.phase(job, 'restarting');
            this.deps.restart(job);
            return job;
        } catch (error) {
            this.fail(job, error);
            throw error;
        }
    }
    /** Startup resumes only a persisted approved job. Never creates repair authority. */
    async resume(jobId: string, candidate: UpgradeCandidate): Promise<UpgradeJob> {
        let job = this.deps.journal.job(jobId);
        if (job.phase === 'completed' || job.phase === 'cancelled') return job;
        if (this.running.has(jobId)) throw new Error('Upgrade runner already active');
        this.running.add(jobId);
        this.gate(job.phase);
        try {
            // Same-process explicit resume retains its lease; restarted process must take it over.
            try { this.deps.journal.assertLease(job); } catch { job.leaseToken = this.deps.journal.acquire(job); this.deps.journal.save(job); }
            const catalog = discoverMigrations(candidate.root, candidate.info);
            if (!catalog || candidate.moduleId !== job.moduleId || candidate.artifactDigest !== job.artifactDigest || catalog.digest !== job.catalogDigest
                || migrationDirectoryDigest(candidate.root) !== job.treeDigest) throw new Error('Approved artifact changed');
            if ((job.transactionDirectory || job.sourceDirectory) && job.fileTransition !== 'registered') {
                throw new Error('Interrupted file/registry promotion; cancel before writes and rerun the reviewed upgrade');
            }
            if (job.phase === 'recovery-required') this.phase(job, 'restarting');
            this.fence(job);
            let source = await this.deps.snapshot(catalog);
            this.assertWorld(job, source.world);
            this.phase(job, 'migrating');
            for (let index = 0; index < job.plan.operations.length; index += 1) {
                this.fence(job);
                job = this.deps.journal.job(jobId); // Includes cancellation/retirement written by another admin action.
                this.fence(job);
                const operation = job.plan.operations[index];
                const key = `${index}:${operation.stepId}:${operation.uuid}`;
                const step = catalog.steps.find(step => step.id === operation.stepId && step.digest === operation.stepDigest);
                if (!step) throw new Error('Approved migration step changed');
                source = await this.deps.snapshot(catalog);
                this.assertWorld(job, source.world);
                const target = source.targets.find(row => row.uuid === operation.uuid);
                if (!target) throw new Error('Approved migration target removed');
                const outcome = job.outcomes[key];
                if (outcome) {
                    const verify = runMigrationHook<{ valid: boolean }>(candidate.root, step, 'verify', hookInput(source.world, target, source.targets, step));
                    if (verify.valid === true) {
                        job.outcomes[key] = { state: 'confirmed', before: outcome.before, post: sourceHash(target.source) };
                        this.deps.journal.save(job); continue;
                    }
                    if (outcome.state === 'confirmed') throw new Error('Verified source regressed; external restore requires new admin preview');
                }
                if (targetSourceHash(target.source) !== operation.sourceHash) throw new Error('Migration source conflict; new preview required');
                const expected = applyMigrationPatch(target.source, operation.updates);
                // The original patch remains exact. A hook/code change cannot replan under old approval.
                job.outcomes[key] = { state: 'intent', before: operation.sourceHash, post: sourceHash(expected) };
                job.possibleWrite = true;
                this.deps.journal.save(job);
                this.fence(job);
                try {
                    await this.deps.write(target, operation.updates, () => this.fence(job));
                } catch {
                    const latest = this.deps.journal.job(jobId);
                    if (latest.outcomes[key]) latest.outcomes[key].state = 'uncertain';
                    this.deps.journal.save(latest);
                    throw new Error('Migration acknowledgement uncertain; inspect source before resuming');
                }
                const after = await this.deps.snapshot(catalog);
                this.assertWorld(job, after.world);
                const actual = after.targets.find(row => row.uuid === target.uuid);
                if (!actual || runMigrationHook<{ valid: boolean }>(candidate.root, step, 'verify', hookInput(after.world, actual, after.targets, step)).valid !== true) throw new Error('Migration post-write verification failed');
                job.outcomes[key] = { state: 'confirmed', before: operation.sourceHash, post: sourceHash(actual.source) };
                this.deps.journal.save(job);
            }
            this.phase(job, 'verifying');
            const actual = await this.deps.snapshot(catalog);
            this.assertWorld(job, actual.world);
            const checked = planWorldMigrations(candidate.root, catalog, actual.world, actual.targets, true, actual.exclusions);
            if (checked.blockers.length) throw new Error('Required source checks still need maintenance');
            await this.deps.prepare(job);
            this.fence(job);
            // Preparation can await module work while native editing continues.
            // Never publish a prepared model from a replaced source snapshot.
            const preparedSource = await this.deps.snapshot(catalog);
            this.assertWorld(job, preparedSource.world);
            if (sourceHash(preparedSource.targets) !== sourceHash(actual.targets)
                || planWorldMigrations(candidate.root, catalog, preparedSource.world, preparedSource.targets, true).blockers.length) throw new Error('Source changed during preparation; recovery required');
            await this.deps.activate(job);
            this.fence(job);
            this.phase(job, 'completed');
            this.deps.journal.release(job);
            this.deps.gate.release('module-upgrade');
            return job;
        } catch (error) { this.fail(job, error); throw error; }
        finally { this.running.delete(jobId); }
    }
    /** Explicit fresh review of a stopped partial job, preserving its write ledger. */
    async reviewRecovery(jobId: string, candidate: UpgradeCandidate): Promise<UpgradePreview> {
        const job = this.deps.journal.job(jobId);
        if (job.phase !== 'recovery-required' || this.running.has(jobId)) throw new Error('Stop the job before fresh review');
        if (job.artifactDigest !== candidate.artifactDigest || job.treeDigest !== migrationDirectoryDigest(candidate.root)) throw new Error('Recovery artifact changed');
        const preview = await this.preview(candidate);
        const sameWorld = ['instanceId', 'worldId', 'systemId'] as const;
        if (sameWorld.some(key => preview.plan.world.identity[key] !== job.plan.world.identity[key])) throw new Error('Wrong world for recovery');
        preview.recoveryJobId = jobId; this.deps.journal.savePreview(preview);
        return preview;
    }
    async reapprove(jobId: string, candidate: UpgradeCandidate, planId: string, administrator: string, backupAcknowledged: boolean): Promise<UpgradeJob> {
        const job = this.deps.journal.job(jobId);
        const preview = this.deps.journal.preview(planId);
        if (!administrator || !backupAcknowledged || job.phase !== 'recovery-required' || this.running.has(jobId)
            || preview.recoveryJobId !== jobId || preview.expiresAt < this.now() || preview.plan.blockers.length
            || preview.artifactDigest !== candidate.artifactDigest || preview.treeDigest !== migrationDirectoryDigest(candidate.root)
            || job.catalogDigest !== preview.catalogDigest) throw new Error('Recovery approval is blocked, changed or stale');
        try { this.deps.journal.assertLease(job); } catch { job.leaseToken = this.deps.journal.acquire(job); }
        const catalog = discoverMigrations(candidate.root, candidate.info)!;
        const source = await this.deps.snapshot(catalog);
        this.deps.assertAuthority(); this.deps.journal.assertLease(job);
        if (planWorldMigrations(candidate.root, catalog, source.world, source.targets, false, source.exclusions).digest !== preview.plan.digest) throw new Error('Recovery source changed; review again');
        job.priorApprovals = [...(job.priorApprovals ?? []), { planId: job.id, digest: job.plan.digest, outcomes: job.outcomes, reviewedAt: this.now() }];
        job.plan = preview.plan; job.id = preview.id; job.expiresAt = preview.expiresAt; job.outcomes = {};
        job.administrator = administrator;
        this.phase(job, 'restarting');
        return job;
    }
    async cancel(jobId: string): Promise<UpgradeJob> {
        const job = this.deps.journal.job(jobId);
        if (job.phase === 'completed' || job.phase === 'cancelled') return job;
        try { this.deps.journal.assertLease(job); } catch { job.leaseToken = this.deps.journal.acquire(job); this.deps.journal.save(job); }
        if (job.possibleWrite) {
            this.fail(job, new Error('Scheduling stopped; possible writes cannot be undone by SheetDelver'));
            return job;
        }
        this.phase(job, 'recovery-required'); // Fences a runner before draining/restoring files.
        await this.deps.gate.drain();
        await this.deps.rollbackFiles(job);
        this.phase(job, 'cancelled');
        this.deps.journal.release(job);
        this.deps.gate.release('module-upgrade');
        return job;
    }
    private assertWorld(job: UpgradeJob, current: Readonly<ModuleWorldSnapshot>): void {
        const previous = job.plan.world;
        const stable = (snapshot: Readonly<ModuleWorldSnapshot>) => ({ ...snapshot.identity, runtimeEpoch: 0, contextRevision: 0 });
        if (canonicalJson(stable(previous)) !== canonicalJson(stable(current)) || canonicalJson(previous.settings) !== canonicalJson(current.settings)) throw new Error('Approved world or rule inputs changed');
        this.fence(job);
    }
    private fence(job: UpgradeJob): void {
        this.deps.journal.assertLease(job);
        const current = this.deps.journal.job(job.jobId);
        if (['completed', 'cancelled', 'recovery-required'].includes(current.phase)) throw new Error('Upgrade scheduling retired');
        this.deps.assertAuthority();
    }
    private gate(phase: UpgradePhase): void {
        this.deps.gate.block('module-upgrade', { phase, message: phase === 'recovery-required'
            ? 'World unavailable — maintenance required' : 'Module upgrade in progress' });
    }
    private phase(job: UpgradeJob, phase: UpgradePhase): void {
        job.phase = phase; delete job.failure;
        job.worldDataStatus = phase === 'completed' ? 'verified' : 'maintenance';
        if (phase === 'completed') { job.completedAt = this.now(); job.retainedFiles = 'retained'; job.servingVersion = job.candidateVersion; }
        this.deps.journal.save(job);
        if (phase !== 'completed' && phase !== 'cancelled') this.gate(phase);
    }
    private fail(job: UpgradeJob, error: unknown): void {
        const latest = this.deps.journal.job(job.jobId);
        if (['completed', 'cancelled', 'recovery-required'].includes(latest.phase)) return;
        job = latest;
        job.phase = 'recovery-required'; job.failure = error instanceof Error ? error.message : 'Upgrade failed';
        this.deps.journal.save(job); this.gate(job.phase);
    }
}
