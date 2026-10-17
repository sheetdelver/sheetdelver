import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ensureOwnerOnlyDirectorySync, writeOwnerOnlyFileAtomicSync } from '@core/paths';
import { sourceHash, type MigrationWorldPlan } from './planner';
import type { UpgradeCandidate } from './ModuleUpgradeCoordinator';

export type UpgradePhase = 'planned' | 'quiescing' | 'installing' | 'restarting' | 'migrating' | 'verifying'
    | 'recovery-required' | 'completed' | 'cancelled';
export interface UpgradePreview {
    id: string;
    moduleId: string;
    artifactDigest: string;
    catalogDigest: string;
    candidateVersion: string;
    treeDigest: string;
    stepDigests: Record<string, string>;
    expiresAt: number;
    plan: MigrationWorldPlan;
    recoveryJobId?: string;
}
export interface UpgradeJob extends UpgradePreview {
    jobId: string;
    idempotencyKey: string;
    phase: UpgradePhase;
    administrator: string;
    backupWarningRevision: 1;
    backupAcknowledged: true;
    leaseToken: string;
    candidateRoot: string;
    sourceDirectory?: string;
    sourceDigest?: string;
    sourceCategory?: 'local' | 'managed';
    transactionDirectory?: string;
    targetDirectory?: string;
    previousDirectory?: string;
    registryBackups?: Array<{ path: string; contents: string | null }>;
    fileTransition?: 'intent' | 'previous-retained' | 'promoted' | 'registered';
    outcomes: Record<string, { state: 'intent' | 'confirmed' | 'uncertain'; before: string; post?: string }>;
    possibleWrite: boolean;
    failure?: string;
    completedAt?: number;
    priorApprovals?: Array<{ planId: string; digest: string; outcomes: UpgradeJob['outcomes']; reviewedAt: number }>;
    retainedFiles?: 'retained' | 'cleaned';
    installedVersion?: string;
    servingVersion?: string;
    worldDataStatus?: 'unverified' | 'maintenance' | 'verified';
}

/** Owner-only, fsync-before-send records outside evictable/module caches. */
export class UpgradeJournal {
    private cached = new Map<string, { stamp: string; base: UpgradeJob; outcomes: UpgradeJob['outcomes']; offset: number; metadata: string }>();
    constructor(readonly root: string, readonly lockRoot = path.join(root, 'leases')) {
        ensureOwnerOnlyDirectorySync(root);
        ensureOwnerOnlyDirectorySync(lockRoot);
    }
    private file(kind: 'plans' | 'jobs', id: string): string {
        if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error('Invalid upgrade record identity');
        const directory = path.join(this.root, kind);
        ensureOwnerOnlyDirectorySync(directory);
        return path.join(directory, `${id}.json`);
    }
    private durableWrite(file: string, value: unknown): void {
        writeOwnerOnlyFileAtomicSync(file, JSON.stringify(value));
        if (process.platform !== 'win32') {
            const descriptor = fs.openSync(path.dirname(file), 'r');
            try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
        }
    }
    private metadata(job: UpgradeJob): string {
        const copy = { ...job } as UpgradeJob & { receiptSchema?: number };
        delete copy.receiptSchema;
        return sourceHash({ ...copy, plan: job.plan.digest, outcomes: null,
            priorApprovals: job.priorApprovals?.map(row => ({ planId: row.planId, digest: row.digest, reviewedAt: row.reviewedAt })) ?? [] });
    }
    private syncLocks(): void {
        if (process.platform === 'win32') return;
        const descriptor = fs.openSync(this.lockRoot, 'r');
        try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    }
    savePreview(preview: UpgradePreview): void { this.durableWrite(this.file('plans', preview.id), preview); }
    private read(file: string): unknown {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('Invalid or oversized upgrade journal record');
        const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid upgrade record');
        return value;
    }
    private validatePreview(value: UpgradePreview): UpgradePreview {
        if (!/^[a-zA-Z0-9-]{1,128}$/.test(value.id) || !/^[a-zA-Z0-9_-]+$/.test(value.moduleId)
            || !Number.isFinite(value.expiresAt) || !value.plan?.world?.identity?.worldId
            || !Array.isArray(value.plan.operations) || !Array.isArray(value.plan.blockers)
            || !value.stepDigests || ![value.artifactDigest, value.treeDigest, value.catalogDigest, value.plan.digest].every(digest => /^sha256:[a-f0-9]{64}$/.test(digest))) throw new Error('Invalid upgrade preview schema');
        return value;
    }
    preview(id: string): UpgradePreview { return this.validatePreview(this.read(this.file('plans', id)) as UpgradePreview); }
    saveSourceCandidate(id: string, candidate: UpgradeCandidate): void { this.durableWrite(this.file('plans', `${id}-source`), candidate); }
    sourceCandidate(id: string): UpgradeCandidate {
        const value = this.read(this.file('plans', `${id}-source`)) as UpgradeCandidate;
        if (typeof value.root !== 'string' || !value.info || typeof value.moduleId !== 'string') throw new Error('Invalid source candidate');
        return value;
    }
    save(job: UpgradeJob): void {
        const file = this.file('jobs', job.jobId);
        if (fs.existsSync(file)) this.job(job.jobId); // includes external cancellation/reapproval before updating receipts
        const cached = this.cached.get(job.jobId);
        const receipts = `${file}.receipts`;
        const previous = cached?.base.id === job.id ? cached.outcomes : {};
        const inlineLegacy = !!cached && Object.keys(cached.base.outcomes).length > 0;
        const changed = Object.entries(job.outcomes).filter(([key, value]) => inlineLegacy || previous[key] !== value && JSON.stringify(previous[key]) !== JSON.stringify(value));
        if (changed.length) {
            const existed = fs.existsSync(receipts);
            const fd = fs.openSync(receipts, 'a', 0o600);
            try {
                fs.writeSync(fd, changed.map(([key, value]) => JSON.stringify({ approval: job.id, key, value })).join('\n') + '\n');
                fs.fsyncSync(fd);
            } finally { fs.closeSync(fd); }
            if (!existed && process.platform !== 'win32') {
                const directory = fs.openSync(path.dirname(receipts), 'r');
                try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
            }
        }
        // The immutable plan is not rewritten for each target receipt. New
        // approval IDs namespace receipts, so reapproval never erases history.
        const metadata = this.metadata(job);
        if (!cached || inlineLegacy || cached.metadata !== metadata) {
            this.durableWrite(file, { ...job, outcomes: {}, receiptSchema: 1 });
            this.cached.delete(job.jobId);
        }
        // Read the fsynced receipt tail once. Subsequent checks reuse immutable
        // plan bytes and consume only newly appended outcome records.
        this.job(job.jobId);
    }
    job(id: string): UpgradeJob {
        const file = this.file('jobs', id); const stat = fs.statSync(file);
        const stamp = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
        let cached = this.cached.get(id);
        if (!cached || cached.stamp !== stamp) {
            const base = this.validatePreview(this.read(file) as UpgradeJob) as UpgradeJob;
            const freeze = (value: unknown): void => { if (!value || typeof value !== 'object') return; Object.values(value).forEach(freeze); Object.freeze(value); };
            freeze(base.plan);
            cached = { stamp, base, outcomes: structuredClone(base.outcomes), offset: 0,
                metadata: this.metadata(base) };
            this.cached.set(id, cached);
        }
        const receipts = `${file}.receipts`;
        if (fs.existsSync(receipts)) {
            const size = fs.statSync(receipts).size;
            if (size < cached.offset) throw new Error('Migration receipt journal was truncated; preserve evidence for recovery');
            if (size > cached.offset) {
                const fd = fs.openSync(receipts, 'r'); const tail = Buffer.alloc(size - cached.offset);
                try { fs.readSync(fd, tail, 0, tail.length, cached.offset); } finally { fs.closeSync(fd); }
                const text = tail.toString('utf8');
                if (!text.endsWith('\n')) throw new Error('Incomplete migration receipt journal; preserve intent and reconcile the final record before resuming');
                for (const line of text.trimEnd().split('\n')) {
                    const record = JSON.parse(line);
                    if (record.approval === cached.base.id) cached.outcomes[record.key] = Object.freeze(record.value);
                }
                cached.offset = size;
            }
        }
        const value = { ...cached.base, outcomes: { ...cached.outcomes } };
        if (value.jobId !== id || !['planned', 'quiescing', 'installing', 'restarting', 'migrating', 'verifying', 'recovery-required', 'completed', 'cancelled'].includes(value.phase)
            || value.backupAcknowledged !== true || value.backupWarningRevision !== 1 || typeof value.administrator !== 'string'
            || typeof value.possibleWrite !== 'boolean' || typeof value.outcomes !== 'object' || !value.outcomes) throw new Error('Invalid upgrade job schema');
        return value;
    }
    jobs(): UpgradeJob[] {
        const directory = path.join(this.root, 'jobs');
        if (!fs.existsSync(directory)) return [];
        return fs.readdirSync(directory).filter(name => /^[a-zA-Z0-9-]+\.json$/.test(name))
            .map(name => this.job(name.slice(0, -5)));
    }
    leaseKey(job: Pick<UpgradePreview, 'plan' | 'moduleId'>): string {
        return sourceHash(['world', job.plan.world.identity.instanceId, job.plan.world.identity.worldId]).slice(7);
    }
    private leaseFile(key: string): string {
        if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid world lease key');
        return path.join(this.lockRoot, key);
    }
    acquire(job: Pick<UpgradeJob, 'jobId' | 'moduleId' | 'plan'>): string {
        const token = randomUUID();
        const keys = [this.leaseKey(job), sourceHash(['module', job.moduleId]).slice(7)];
        const acquired: string[] = [];
        try {
            for (const key of keys) { this.acquireLock(this.leaseFile(key), job, token); acquired.push(key); }
        } catch (error) {
            for (const key of acquired) {
                const lock = this.leaseFile(key);
                fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock);
            }
            throw error;
        }
        this.syncLocks(); return token;
    }
    private acquireLock(lock: string, job: Pick<UpgradeJob, 'jobId'>, token: string): void {
        const owner = { token, jobId: job.jobId, host: os.hostname(), pid: process.pid };
        try {
            fs.mkdirSync(lock, { mode: 0o700 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            // Serialize restart takeover. No TTL steal, no cross-host liveness guess.
            const recovery = `${lock}.recovery`;
            fs.mkdirSync(recovery, { mode: 0o700 });
            try {
                const previous = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')) as typeof owner;
                if (previous.jobId !== job.jobId || previous.host !== os.hostname()) throw new Error('Another installation owns this world lease');
                let alive = true;
                try { process.kill(previous.pid, 0); } catch (failure) { alive = (failure as NodeJS.ErrnoException).code !== 'ESRCH'; }
                if (alive) throw new Error('Another live runner owns this world lease');
                this.durableWrite(path.join(lock, 'owner.json'), owner);
            } finally { fs.rmdirSync(recovery); }
            return;
        }
        this.durableWrite(path.join(lock, 'owner.json'), owner);
    }
    assertLease(job: Pick<UpgradeJob, 'jobId' | 'moduleId' | 'plan' | 'leaseToken'>): void {
        for (const key of [this.leaseKey(job), sourceHash(['module', job.moduleId]).slice(7)]) {
            const owner = JSON.parse(fs.readFileSync(path.join(this.leaseFile(key), 'owner.json'), 'utf8')) as { token: string; jobId: string; host: string; pid: number };
            if (owner.token !== job.leaseToken || owner.jobId !== job.jobId || owner.host !== os.hostname() || owner.pid !== process.pid) throw new Error('Upgrade lease lost');
        }
    }
    release(job: Pick<UpgradeJob, 'jobId' | 'moduleId' | 'plan' | 'leaseToken'>): void {
        this.assertLease(job);
        for (const key of [this.leaseKey(job), sourceHash(['module', job.moduleId]).slice(7)]) {
            const lock = this.leaseFile(key);
            fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock);
        }
        this.syncLocks();
    }
}
