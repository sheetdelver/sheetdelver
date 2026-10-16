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
    save(job: UpgradeJob): void { this.durableWrite(this.file('jobs', job.jobId), job); }
    job(id: string): UpgradeJob {
        const value = this.validatePreview(this.read(this.file('jobs', id)) as UpgradeJob) as UpgradeJob;
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
    acquire(job: UpgradeJob): string {
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
    private acquireLock(lock: string, job: UpgradeJob, token: string): void {
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
    assertLease(job: UpgradeJob): void {
        for (const key of [this.leaseKey(job), sourceHash(['module', job.moduleId]).slice(7)]) {
            const owner = JSON.parse(fs.readFileSync(path.join(this.leaseFile(key), 'owner.json'), 'utf8')) as { token: string; jobId: string; host: string; pid: number };
            if (owner.token !== job.leaseToken || owner.jobId !== job.jobId || owner.host !== os.hostname() || owner.pid !== process.pid) throw new Error('Upgrade lease lost');
        }
    }
    release(job: UpgradeJob): void {
        this.assertLease(job);
        for (const key of [this.leaseKey(job), sourceHash(['module', job.moduleId]).slice(7)]) {
            const lock = this.leaseFile(key);
            fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock);
        }
        this.syncLocks();
    }
}
