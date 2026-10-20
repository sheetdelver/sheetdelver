import { randomUUID } from 'node:crypto';
import { canonicalJson, discoverMigrations, migrationDirectoryDigest, type ResolvedMigrationCatalog } from '@modules/registry/migrations/catalog';
import { assertMigrationSource } from '@modules/registry/migrations/sourceInspection';
import type { SystemModuleInfo } from '@modules/registry/core/types';
import type { ModuleWorldSnapshot } from '@shared/sdk/world';
import type { MigrationTarget } from '@shared/sdk/migrations';
import { WorldWorkGate } from '@server/core/world/WorldWorkGate';
import { type UpgradeJob, type UpgradePreview, type UpgradePhase } from './UpgradeJournal';
import type { UpgradeJournalAccess } from './AsyncUpgradeJournal';
import { applyMigrationPatch, hookInput, migrationInputHashes, migrationTargetHash, sourceHash, targetSourceHash, migrationReason, migrationSimulation, simulateMigrationOperation, type PlannedMigrationTarget } from './planner';
import { computeWorldMigrations, type MigrationComputeProgress } from './compute';
import { runMigrationHook } from './hooks';
import { createMigrationHookRunner } from './hooks';
import { migrationEnvelope } from './targets';

export interface UpgradeCandidate {
    moduleId: string; version: string; artifactDigest: string; root: string; info: SystemModuleInfo;
    sourceDirectory?: string; sourceDigest?: string; sourceCategory?: 'local' | 'managed';
    /** Owner-only retained archive input; never supplied to hooks or players. */
    archive?: { operation: 'install' | 'upgrade'; input: import('@modules/registry/core/archiveOperations').LocalModuleArchiveInput };
}
export interface UpgradeSourceSnapshot { world: Readonly<ModuleWorldSnapshot>; targets: MigrationTarget[]; exclusions?: string[]; assertCurrent?: () => void }
export interface UpgradeCoordinatorDeps {
    journal: UpgradeJournalAccess;
    gate: WorldWorkGate;
    /** Fresh source, without candidate adapter initialization or user readiness. */
    snapshot(catalog: ResolvedMigrationCatalog, previous?: UpgradeSourceSnapshot, operation?: PlannedMigrationTarget): Promise<UpgradeSourceSnapshot>;
    progress?(progress: MigrationComputeProgress): void;
    jobIdentity?(): string;
    acquireLease?(job: UpgradeJob): string;
    /** Host binds a durable first approval, or retires a proven unpublished intent.
     * The persistent maintenance operation retains its lease until admin cancel. */
    settleApproval?(expected: UpgradeJob, durable: UpgradeJob | null): void;
    assertApproval?(preview: UpgradePreview): void;
    assertAuthority(): void;
    write(target: MigrationTarget, updates: Record<string, unknown>, fence: () => void): Promise<void>;
    writeBatch?(entries: Array<{ target: MigrationTarget; updates: Record<string, unknown> }>, fence: () => void): Promise<void>;
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
    async restoreGate(): Promise<void> {
        for (const job of (await this.deps.journal.jobs())) if (!['completed', 'cancelled'].includes(job.phase)) this.gate(job.phase);
    }
    async preview(candidate: UpgradeCandidate): Promise<UpgradePreview> {
        assertMigrationSource(candidate);
        const catalog = discoverMigrations(candidate.root, candidate.info);
        if (!catalog) throw new Error('Candidate has no migration catalog');
        for (const job of (await this.deps.journal.jobs()).filter(job => job.moduleId === candidate.moduleId && job.possibleWrite)) {
            for (const [id, digest] of Object.entries(job.stepDigests)) {
                if (catalog.steps.find(step => step.id === id)?.digest !== digest) throw new Error('Historical migration step removed or changed; use a new stable step ID');
            }
        }
        this.deps.assertAuthority();
        const source = await this.deps.snapshot(catalog);
        this.deps.assertAuthority();
        if (source.world.identity.systemId !== candidate.moduleId && !candidate.info.aliases?.includes(source.world.identity.systemId)) throw new Error('Wrong world/system for migration preview');
        const plan = await computeWorldMigrations(candidate.root, catalog, source.world, source.targets, false, source.exclusions, this.deps.progress);
        source.assertCurrent?.();
        const preview: UpgradePreview = { id: randomUUID(), moduleId: candidate.moduleId, artifactDigest: candidate.artifactDigest,
            treeDigest: migrationDirectoryDigest(candidate.root),
            stepDigests: Object.fromEntries(catalog.steps.map(step => [step.id, step.digest])),
            candidateVersion: candidate.version, catalogDigest: catalog.digest, expiresAt: this.now() + 15 * 60_000, plan };
        await this.deps.journal.savePreview(preview);
        assertMigrationSource(candidate);
        source.assertCurrent?.(); this.deps.assertAuthority();
        return preview;
    }
    async approve(candidate: UpgradeCandidate, approval: { planId: string; idempotencyKey: string; backupAcknowledged: boolean; administrator: string }): Promise<UpgradeJob> {
        assertMigrationSource(candidate);
        if (!approval.backupAcknowledged) throw new Error('Foundry backup / no SheetDelver undo warning acknowledgement required');
        if (!/^[a-zA-Z0-9-]{8,128}$/.test(approval.idempotencyKey) || !approval.administrator) throw new Error('Invalid admin approval');
        const existing = (await this.deps.journal.jobs()).find(job => job.idempotencyKey === approval.idempotencyKey);
        if (existing) {
            if (existing.id !== approval.planId || existing.artifactDigest !== candidate.artifactDigest) throw new Error('Idempotency key is bound to another approval');
            return existing;
        }
        const preview = (await this.deps.journal.preview(approval.planId));
        this.deps.assertApproval?.(preview);
        if (preview.recoveryJobId) throw new Error('Recovery preview requires explicit reapproval of the existing job');
        if ((await this.deps.journal.jobs()).some(job => !['completed', 'cancelled'].includes(job.phase)
            && (job.moduleId === candidate.moduleId || this.deps.journal.leaseKey(job) === this.deps.journal.leaseKey(preview)))) throw new Error('Another approved job owns the world/module lease');
        const catalog = discoverMigrations(candidate.root, candidate.info);
        if (!catalog || preview.expiresAt < this.now() || preview.artifactDigest !== candidate.artifactDigest
            || preview.moduleId !== candidate.moduleId || preview.candidateVersion !== candidate.version || preview.catalogDigest !== catalog.digest
            || preview.treeDigest !== migrationDirectoryDigest(candidate.root)
            || preview.plan.blockers.length) throw new Error('Upgrade preview is blocked, stale or changed');
        const job: UpgradeJob = { ...preview, jobId: this.deps.jobIdentity?.() ?? randomUUID(), administrator: approval.administrator, idempotencyKey: approval.idempotencyKey,
            phase: 'quiescing', backupAcknowledged: true, backupWarningRevision: 1, leaseToken: '', candidateRoot: candidate.root,
            outcomes: {}, possibleWrite: false, sourceDirectory: candidate.sourceDirectory, sourceDigest: candidate.sourceDigest,
            sourceCategory: candidate.sourceCategory, worldDataStatus: 'unverified' };
        // Persist the gate BEFORE file replacement; process startup loads it before registry/adapter imports.
        // Acquire before publishing a pending job. A losing tab must not leave
        // an orphan maintenance record which can never own the existing lease.
        job.leaseToken = this.deps.acquireLease?.(job) ?? this.deps.journal.acquire(job);
        try { await this.deps.journal.save(job); this.deps.settleApproval?.(job, job); }
        catch (error) {
            // A rejected/cancelled ACK says nothing about durable publication.
            // Join the old writer and read back outside the aborted computation.
            const durable = await this.deps.journal.recoverJob(job.jobId);
            if (durable && (durable.id !== job.id || durable.plan.digest !== job.plan.digest
                || durable.artifactDigest !== job.artifactDigest || durable.moduleId !== job.moduleId
                || durable.idempotencyKey !== job.idempotencyKey || durable.leaseToken !== job.leaseToken)) throw new Error('First approval identity changed; preserve maintenance and journal for recovery');
            if (this.deps.settleApproval) this.deps.settleApproval(job, durable);
            else if (!durable) this.deps.journal.release(job);
            if (durable) this.gate(durable.phase);
            throw error;
        }
        this.gate('quiescing');
        try {
            await this.deps.gate.drain();
            const source = await this.deps.snapshot(catalog);
            this.fence(job);
            const current = await computeWorldMigrations(candidate.root, catalog, source.world, source.targets, false, source.exclusions, this.deps.progress);
            if (current.digest !== preview.plan.digest) throw new Error('World plan changed; rerun preview');
            source.assertCurrent?.();
            await this.phase(job, 'installing');
            source.assertCurrent?.(); this.fence(job);
            await this.deps.promote(job);
            job.installedVersion = job.candidateVersion;
            this.fence(job);
            await this.phase(job, 'restarting');
            this.deps.restart(job);
            return job;
        } catch (error) {
            await this.fail(job, error);
            throw error;
        }
    }
    /** Startup resumes only a persisted approved job. Never creates repair authority. */
    async resume(jobId: string, candidate: UpgradeCandidate): Promise<UpgradeJob> {
        let job = (await this.deps.journal.job(jobId));
        if (job.phase === 'completed' || job.phase === 'cancelled') return job;
        if (this.running.has(jobId)) throw new Error('Upgrade runner already active');
        this.running.add(jobId);
        this.gate(job.phase);
        try {
            // Same-process explicit resume retains its lease; restarted process must take it over.
            try { this.deps.journal.assertLease(job); } catch { job.leaseToken = this.deps.journal.acquire(job); await this.deps.journal.save(job); }
            const catalog = discoverMigrations(candidate.root, candidate.info);
            if (!catalog || candidate.moduleId !== job.moduleId || candidate.artifactDigest !== job.artifactDigest || catalog.digest !== job.catalogDigest
                || migrationDirectoryDigest(candidate.root) !== job.treeDigest) throw new Error('Approved artifact changed');
            assertMigrationSource(job);
            if ((job.transactionDirectory || job.sourceDirectory) && job.fileTransition !== 'registered') {
                throw new Error('Interrupted file/registry promotion; cancel before writes and rerun the reviewed upgrade');
            }
            if (job.phase === 'recovery-required') await this.phase(job, 'restarting');
            this.fence(job);
            let source = await this.deps.snapshot(catalog);
            this.assertWorld(job, source.world);
            await this.phase(job, 'migrating');
            const runHook = createMigrationHookRunner(candidate.root);
            for (let index = 0; index < job.plan.operations.length; index += 1) {
                this.fence(job);
                job = (await this.deps.journal.job(jobId)); // Includes cancellation/retirement written by another admin action.
                this.fence(job);
                const operation = job.plan.operations[index];
                const key = `${index}:${operation.stepId}:${operation.uuid}`;
                const step = catalog.steps.find(step => step.id === operation.stepId && step.digest === operation.stepDigest);
                if (!step) throw new Error('Approved migration step changed');
                // A bounded native update envelope is not a new approval/chunk.
                // Keep legacy broad read sets sequential; their dependency
                // semantics cannot be weakened by grouping sibling mutations.
                const batch = [operation];
                const firstTarget = source.targets.find(row => row.uuid === operation.uuid);
                const envelopeKey = (target: MigrationTarget) => {
                    const envelope = migrationEnvelope(target, {});
                    return JSON.stringify([envelope.type, envelope.operation.parentUuid ?? null, envelope.operation.pack ?? null]);
                };
                if (this.deps.writeBatch && firstTarget && !job.outcomes[key]
                    && !catalog.steps.some(row => row.reads?.targets?.length || row.reads?.packs?.length)) {
                    let bytes = Buffer.byteLength(JSON.stringify(operation.updates));
                    for (let next = index + 1; next < job.plan.operations.length && batch.length < 50; next++) {
                        const row = job.plan.operations[next]; const target = source.targets.find(target => target.uuid === row.uuid);
                        const size = Buffer.byteLength(JSON.stringify(row.updates));
                        if (row.stepId !== operation.stepId || job.outcomes[`${next}:${row.stepId}:${row.uuid}`]
                            || !target || batch.some(prior => prior.uuid === row.uuid) || envelopeKey(target) !== envelopeKey(firstTarget) || bytes + size > 524_288) break;
                        batch.push(row); bytes += size;
                    }
                }
                if (batch.length > 1) {
                    const combined = { ...operation, dependencies: Object.assign({}, ...batch.map(row => row.dependencies)) };
                    source = await this.deps.snapshot(catalog, source, combined);
                    this.assertWorld(job, source.world);
                    const simulated = migrationSimulation(source.targets, batch.map(row => row.uuid));
                    const entries = batch.map(row => {
                        const target = simulated.find(target => target.uuid === row.uuid);
                        if (!target || !row.dependencies || !row.effects) throw new Error('Approval lacks batch dependency evidence');
                        if (sourceHash(migrationInputHashes(source.world, target, simulated, step)) !== sourceHash(row.dependencies)
                            || targetSourceHash(target.source) !== row.sourceHash) throw new Error(`Migration reference/source conflict: ${row.uuid}; new preview required`);
                        const entry = { target: structuredClone(target), updates: row.updates };
                        simulateMigrationOperation(simulated, row);
                        return entry;
                    });
                    source.assertCurrent?.(); this.fence(job);
                    for (let offset = 0; offset < batch.length; offset++) {
                        const row = batch[offset]; const expected = simulated.find(target => target.uuid === row.uuid)!;
                        job.outcomes[`${index + offset}:${row.stepId}:${row.uuid}`] = { state: 'intent', before: row.sourceHash, post: sourceHash(expected.source) };
                    }
                    job.possibleWrite = true; await this.deps.journal.save(job); // fsync every intent before the one native send
                    try { await this.deps.writeBatch!(entries, () => { this.fence(job); source.assertCurrent?.(); }); }
                    catch (error) {
                        for (let offset = 0; offset < batch.length; offset++) {
                            const key = `${index + offset}:${batch[offset].stepId}:${batch[offset].uuid}`;
                            job.outcomes[key] = { ...job.outcomes[key], state: 'uncertain' };
                        }
                        await this.deps.journal.save(job);
                        throw new Error(`Migration batch acknowledgement uncertain: ${step.id}: native-send: ${batch[0].uuid} through ${batch.at(-1)!.uuid} (${batch.length} targets): ${migrationReason(error)}; inspect source before resuming`);
                    }
                    const after = await this.deps.snapshot(catalog, source, combined); this.assertWorld(job, after.world);
                    const confirmed: UpgradeJob['outcomes'] = {};
                    for (let offset = 0; offset < batch.length; offset++) {
                        const row = batch[offset]; const actual = after.targets.find(target => target.uuid === row.uuid);
                        const expected = simulated.find(target => target.uuid === row.uuid)!;
                        this.assertExactReadback(step.id, row.uuid, actual, expected.source);
                        const verify = runHook<{ valid: boolean; reason?: string }>(step, 'verify', hookInput(after.world, actual, after.targets, step));
                        if (verify.valid !== true) throw new Error(`${step.id}: ${row.uuid}: verify: ${migrationReason(verify.reason || 'Post-write verification failed')}`);
                        confirmed[`${index + offset}:${row.stepId}:${row.uuid}`] = { state: 'confirmed', before: row.sourceHash, post: sourceHash(actual.source) };
                    }
                    after.assertCurrent?.(); this.fence(job);
                    Object.assign(job.outcomes, confirmed); await this.deps.journal.save(job); source = after;
                    index += batch.length - 1;
                    this.deps.progress?.({ checked: index + 1, total: job.plan.operations.length, planned: job.plan.operations.length,
                        stepId: step.id, phase: 'migrating', confirmed: Object.values(job.outcomes).filter(row => row.state === 'confirmed').length,
                        uncertain: Object.values(job.outcomes).filter(row => row.state === 'uncertain').length });
                    continue;
                }
                source = await this.deps.snapshot(catalog, source, operation);
                this.assertWorld(job, source.world);
                const target = source.targets.find(row => row.uuid === operation.uuid);
                if (!target) throw new Error(`${step.id}: ${operation.uuid}: source-read: approved migration target removed`);
                const outcome = job.outcomes[key];
                if (!operation.dependencies || !operation.effects) throw new Error('Approval lacks dependency evidence; new preview required');
                const currentInputs = migrationInputHashes(source.world, target, source.targets, step);
                const expectedInputs = { ...operation.dependencies };
                // A restarted job sees the already-applied approved prefix, not
                // the original inventory. Overlay only recorded approved effects;
                // never excuse arbitrary changes or new/deleted reference rows.
                if (outcome) for (let later = index; later < job.plan.operations.length; later++) {
                    const applied = job.plan.operations[later];
                    const appliedOutcome = job.outcomes[`${later}:${applied.stepId}:${applied.uuid}`];
                    if (!appliedOutcome) continue;
                    if (later !== index && appliedOutcome.state !== 'confirmed') {
                        // A later send may have landed before its acknowledgement
                        // was lost. Accept only its exact approved readback here;
                        // its own dependency/verify boundary still runs below.
                        if (!Object.entries(applied.effects ?? {}).every(([uuid, hash]) => {
                            const actual = source.targets.find(row => row.uuid === uuid);
                            return actual && migrationTargetHash(actual) === hash;
                        })) continue;
                    }
                    for (const [uuid, hash] of Object.entries(applied.effects ?? {})) if (uuid in expectedInputs) expectedInputs[uuid] = hash;
                }
                if (outcome) {
                    const verify = runMigrationHook<{ valid: boolean }>(candidate.root, step, 'verify', hookInput(source.world, target, source.targets, step));
                    const superseded = job.plan.operations.slice(index + 1).some((later, offset) => later.uuid === operation.uuid
                        && job.outcomes[`${index + 1 + offset}:${later.stepId}:${later.uuid}`]?.state === 'confirmed');
                    if ((verify.valid === true || outcome.state === 'confirmed' && superseded)
                        && sourceHash(currentInputs) === sourceHash(expectedInputs)) {
                        source.assertCurrent?.(); this.fence(job);
                        job.outcomes[key] = { state: 'confirmed', before: outcome.before, post: sourceHash(target.source) };
                        await this.deps.journal.save(job); continue;
                    }
                    if (outcome.state === 'confirmed') throw new Error('Verified source regressed; external restore requires new admin preview');
                }
                if (sourceHash(currentInputs) !== sourceHash(operation.dependencies)) throw new Error(`${step.id}: ${target.uuid}: Migration reference dependency conflict; new preview required`);
                if (targetSourceHash(target.source) !== operation.sourceHash) throw new Error(`${step.id}: ${target.uuid}: Migration source conflict; new preview required`);
                const expected = applyMigrationPatch(target.source, operation.updates);
                source.assertCurrent?.();
                // The original patch remains exact. A hook/code change cannot replan under old approval.
                job.outcomes[key] = { state: 'intent', before: operation.sourceHash, post: sourceHash(expected) };
                job.possibleWrite = true;
                await this.deps.journal.save(job);
                this.fence(job);
                try {
                    await this.deps.write(target, operation.updates, () => { this.fence(job); source.assertCurrent?.(); });
                } catch (error) {
                    const latest = (await this.deps.journal.job(jobId));
                    if (latest.outcomes[key]) latest.outcomes[key] = { ...latest.outcomes[key], state: 'uncertain' };
                    await this.deps.journal.save(latest);
                    throw new Error(`${step.id}: ${target.uuid}: native-send: Migration acknowledgement uncertain: ${migrationReason(error)}; inspect source before resuming`);
                }
                const after = await this.deps.snapshot(catalog, source, operation);
                this.assertWorld(job, after.world);
                const actual = after.targets.find(row => row.uuid === target.uuid);
                this.assertExactReadback(step.id, target.uuid, actual, expected);
                const verified = runMigrationHook<{ valid: boolean; reason?: string }>(candidate.root, step, 'verify', hookInput(after.world, actual, after.targets, step));
                if (verified.valid !== true) throw new Error(`${step.id}: ${target.uuid}: verify: ${migrationReason(verified.reason || 'Migration post-write verification failed')}`);
                after.assertCurrent?.(); this.fence(job);
                source = after;
                job.outcomes[key] = { state: 'confirmed', before: operation.sourceHash, post: sourceHash(actual.source) };
                await this.deps.journal.save(job);
                if ((index + 1) % 10 === 0 || index + 1 === job.plan.operations.length) this.deps.progress?.({ checked: index + 1, total: job.plan.operations.length, planned: job.plan.operations.length,
                    stepId: step.id, phase: 'migrating', confirmed: Object.values(job.outcomes).filter(row => row.state === 'confirmed').length,
                    uncertain: Object.values(job.outcomes).filter(row => row.state === 'uncertain').length });
            }
            await this.phase(job, 'verifying');
            const actual = await this.deps.snapshot(catalog);
            this.assertWorld(job, actual.world);
            const checked = await computeWorldMigrations(candidate.root, catalog, actual.world, actual.targets, true, actual.exclusions, this.deps.progress);
            actual.assertCurrent?.();
            if (checked.blockers.length) throw new Error(checked.blockers[0]);
            await this.deps.prepare(job);
            this.fence(job);
            // Preparation can await module work while native editing continues.
            // Never publish a prepared model from a replaced source snapshot.
            const preparedSource = await this.deps.snapshot(catalog);
            this.assertWorld(job, preparedSource.world);
            if (sourceHash(preparedSource.targets) !== sourceHash(actual.targets)
                || (await computeWorldMigrations(candidate.root, catalog, preparedSource.world, preparedSource.targets, true, [], this.deps.progress)).blockers.length) throw new Error('Source changed during preparation; recovery required');
            preparedSource.assertCurrent?.();
            if (migrationDirectoryDigest(candidate.root) !== job.treeDigest) throw new Error('Approved artifact changed during execution/preparation');
            assertMigrationSource(job);
            await this.deps.activate(job);
            this.fence(job);
            await this.phase(job, 'completed');
            // Journal durability now awaits another thread. Retire a source
            // changed during that await before releasing readiness or the lease.
            preparedSource.assertCurrent?.(); this.deps.assertAuthority(); this.deps.journal.assertLease(job);
            this.deps.journal.release(job);
            this.deps.gate.release('module-upgrade');
            return job;
        } catch (error) { await this.fail(job, error); throw error; }
        finally { this.running.delete(jobId); }
    }
    /** Explicit fresh review of a stopped partial job, preserving its write ledger. */
    async reviewRecovery(jobId: string, candidate: UpgradeCandidate): Promise<UpgradePreview> {
        assertMigrationSource(candidate);
        const job = (await this.deps.journal.job(jobId));
        if (job.phase !== 'recovery-required' || this.running.has(jobId)) throw new Error('Stop the job before fresh review');
        if (job.artifactDigest !== candidate.artifactDigest || job.treeDigest !== migrationDirectoryDigest(candidate.root)) throw new Error('Recovery artifact changed');
        const preview = await this.preview(candidate);
        const sameWorld = ['instanceId', 'worldId', 'systemId'] as const;
        if (sameWorld.some(key => preview.plan.world.identity[key] !== job.plan.world.identity[key])) throw new Error('Wrong world for recovery');
        preview.recoveryJobId = jobId; await this.deps.journal.savePreview(preview);
        return preview;
    }
    async reapprove(jobId: string, candidate: UpgradeCandidate, planId: string, administrator: string, backupAcknowledged: boolean): Promise<UpgradeJob> {
        assertMigrationSource(candidate);
        const job = (await this.deps.journal.job(jobId));
        const preview = (await this.deps.journal.preview(planId));
        if (!administrator || !backupAcknowledged || job.phase !== 'recovery-required' || this.running.has(jobId)
            || preview.recoveryJobId !== jobId || preview.expiresAt < this.now() || preview.plan.blockers.length
            || preview.artifactDigest !== candidate.artifactDigest || preview.treeDigest !== migrationDirectoryDigest(candidate.root)
            || job.catalogDigest !== preview.catalogDigest) throw new Error('Recovery approval is blocked, changed or stale');
        try { this.deps.journal.assertLease(job); } catch { job.leaseToken = this.deps.journal.acquire(job); }
        const catalog = discoverMigrations(candidate.root, candidate.info)!;
        const source = await this.deps.snapshot(catalog);
        this.deps.assertAuthority(); this.deps.journal.assertLease(job);
        if ((await computeWorldMigrations(candidate.root, catalog, source.world, source.targets, false, source.exclusions, this.deps.progress)).digest !== preview.plan.digest) throw new Error('Recovery source changed; review again');
        source.assertCurrent?.();
        job.priorApprovals = [...(job.priorApprovals ?? []), { planId: job.id, digest: job.plan.digest, outcomes: job.outcomes, reviewedAt: this.now() }];
        job.plan = preview.plan; job.id = preview.id; job.expiresAt = preview.expiresAt; job.outcomes = {};
        job.administrator = administrator;
        await this.phase(job, 'restarting');
        return job;
    }
    async cancel(jobId: string): Promise<UpgradeJob> {
        const job = (await this.deps.journal.job(jobId));
        if (job.phase === 'completed' || job.phase === 'cancelled') return job;
        try { this.deps.journal.assertLease(job); } catch { job.leaseToken = this.deps.journal.acquire(job); await this.deps.journal.save(job); }
        if (job.possibleWrite) {
            await this.fail(job, new Error('Scheduling stopped; possible writes cannot be undone by SheetDelver'));
            return job;
        }
        await this.phase(job, 'recovery-required'); // Fences a runner before draining/restoring files.
        await this.deps.gate.drain();
        await this.deps.rollbackFiles(job);
        await this.phase(job, 'cancelled');
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
    private assertExactReadback(stepId: string, uuid: string, actual: MigrationTarget | undefined, expected: Record<string, unknown>): asserts actual is MigrationTarget {
        if (!actual || targetSourceHash(actual.source) !== targetSourceHash(expected)) {
            throw new Error(`${stepId}: ${uuid}: readback differs from exact approved source; preserve intent and review recovery`);
        }
    }
    private fence(job: UpgradeJob): void {
        this.deps.journal.assertLease(job);
        this.deps.journal.assertActive(job);
        this.deps.assertAuthority();
    }
    private gate(phase: UpgradePhase): void {
        this.deps.gate.block('module-upgrade', { phase, message: phase === 'recovery-required'
            ? 'World unavailable — maintenance required' : 'Module upgrade in progress' });
    }
    private async phase(job: UpgradeJob, phase: UpgradePhase): Promise<void> {
        job.phase = phase; delete job.failure;
        job.worldDataStatus = phase === 'completed' ? 'verified' : 'maintenance';
        if (phase === 'completed') { job.completedAt = this.now(); job.retainedFiles = 'retained'; job.servingVersion = job.candidateVersion; }
        await this.deps.journal.save(job);
        if (phase !== 'completed' && phase !== 'cancelled') this.gate(phase);
    }
    private async fail(job: UpgradeJob, error: unknown): Promise<void> {
        const latest = (await this.deps.journal.job(job.jobId));
        if (['cancelled', 'recovery-required'].includes(latest.phase)
            || latest.phase === 'completed' && !this.running.has(job.jobId)) return;
        job = latest;
        job.phase = 'recovery-required'; job.worldDataStatus = 'maintenance'; job.failure = migrationReason(error);
        await this.deps.journal.save(job); this.gate(job.phase);
    }
}
