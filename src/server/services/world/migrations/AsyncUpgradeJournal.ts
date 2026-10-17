import { Worker } from 'node:worker_threads';
import { UpgradeJournal, type UpgradeJob, type UpgradePreview } from './UpgradeJournal';
import type { UpgradeCandidate } from './ModuleUpgradeCoordinator';
import type { MigrationWorldPlan } from './planner';
import type { StoredMigrationPlan } from './MigrationPlanStorage';
import { getMaintenanceComputationSignal } from '@core/world/MaintenanceMode';
import { upgradeReview } from './upgradeReview';

type MaybePromise<T> = T | Promise<T>;
export interface UpgradeJournalAccess extends Pick<UpgradeJournal, 'root' | 'lockRoot' | 'leaseKey' | 'acquire' | 'release' | 'assertLease' | 'assertActive'> {
    savePreview(value: UpgradePreview): MaybePromise<void>;
    preview(id: string): MaybePromise<UpgradePreview>;
    saveSourceCandidate(id: string, value: UpgradeCandidate): MaybePromise<void>;
    sourceCandidate(id: string): MaybePromise<UpgradeCandidate>;
    save(value: UpgradeJob): MaybePromise<void>;
    job(id: string): MaybePromise<UpgradeJob>;
    jobs(): MaybePromise<UpgradeJob[]>;
    recoverJob(id: string): MaybePromise<UpgradeJob | null>;
}

/** One serialized, process-owned storage worker. Durable ACK precedes authority. */
export class AsyncUpgradeJournal implements UpgradeJournalAccess {
    private readonly leases: UpgradeJournal;
    private worker?: Worker;
    private tail: Promise<unknown> = Promise.resolve();
    private retired = false;
    private sequence = 0;
    private plans = new Map<string, MigrationWorldPlan>();
    private references = new WeakMap<MigrationWorldPlan, StoredMigrationPlan>();
    private jobSnapshots = new Map<string, UpgradeJob>();
    private previews = new Map<string, ReturnType<typeof upgradeReview>>();
    constructor(readonly root: string, readonly lockRoot: string) { this.leases = new UpgradeJournal(root, lockRoot); }
    leaseKey: UpgradeJournal['leaseKey'] = job => this.leases.leaseKey(job);
    acquire: UpgradeJournal['acquire'] = job => this.leases.acquire(job);
    release: UpgradeJournal['release'] = job => this.leases.release(job);
    assertLease: UpgradeJournal['assertLease'] = job => this.leases.assertLease(job);
    assertActive: UpgradeJournal['assertActive'] = job => this.leases.assertActive(job);
    async savePreview(value: UpgradePreview): Promise<void> { await this.call('savePreview', [value]); this.previews.set(value.id, upgradeReview(value)); }
    async preview(id: string): Promise<UpgradePreview> { const value = await this.call<UpgradePreview>('preview', [id]); this.previews.set(id, upgradeReview(value)); return value; }
    saveSourceCandidate(id: string, value: UpgradeCandidate): Promise<void> { return this.call('saveSourceCandidate', [id, value]); }
    sourceCandidate(id: string): Promise<UpgradeCandidate> { return this.call('sourceCandidate', [id]); }
    async save(value: UpgradeJob): Promise<void> { await this.call('save', [value]); this.jobSnapshots.set(value.jobId, value); }
    async job(id: string): Promise<UpgradeJob> { const value = await this.call<UpgradeJob>('job', [id]); this.jobSnapshots.set(id, value); return value; }
    async jobs(): Promise<UpgradeJob[]> { const values = await this.call<UpgradeJob[]>('jobs', []); values.forEach(value => this.jobSnapshots.set(value.jobId, value)); return values; }
    /** Joined, serialized readback cannot borrow the cancelled computation signal.
     * Only recovery reads use this path; ordinary writes stay cancellable. */
    async recoverJob(id: string): Promise<UpgradeJob | null> {
        const value = await this.call<UpgradeJob | null>('recoverJob', [id], true);
        if (value) this.jobSnapshots.set(id, value); else this.jobSnapshots.delete(id);
        return value;
    }
    peekJob(id: string) { return this.jobSnapshots.get(id); }
    peekPreview(id: string) { return this.previews.get(id); }
    async drain(): Promise<void> { await this.tail; }
    async close(): Promise<void> { this.retired = true; await this.tail.catch(() => {}); await this.worker?.terminate(); this.worker = undefined; }
    private encode(value: any): any {
        const reference = value?.plan && this.references.get(value.plan);
        return reference ? { ...value, plan: { __upgradePlan: reference } } : value;
    }
    private async decode(value: any): Promise<any> {
        if (Array.isArray(value)) return Promise.all(value.map(row => this.decode(row)));
        if (!value?.plan?.__upgradePlan) return value;
        const reference = value.plan.__upgradePlan as StoredMigrationPlan;
        let plan = this.plans.get(reference.digest);
        if (!plan) {
            plan = value.plan.value;
            if (!plan || plan.digest !== reference.digest) throw new Error('Storage worker omitted approved plan');
            // Worker snapshots are immutable. Restore that invariant without a
            // whole-plan synchronous freeze monopolizing the HTTP loop.
            const pending: any[] = [plan]; let checked = 0;
            while (pending.length) {
                const entry = pending.pop();
                if (entry && typeof entry === 'object' && !Object.isFrozen(entry)) { for (const child of Object.values(entry)) pending.push(child); Object.freeze(entry); }
                if (++checked % 2000 === 0) await new Promise<void>(resolve => setImmediate(resolve));
            }
            this.plans.set(reference.digest, plan!); this.references.set(plan!, reference);
        }
        return { ...value, plan };
    }
    private call<T>(method: string, args: unknown[], recovery = false): Promise<T> {
        if (this.retired) return Promise.reject(new Error('Upgrade storage worker retired'));
        const signal = recovery ? undefined : getMaintenanceComputationSignal();
        const task = this.tail.catch(() => {}).then(async () => {
            signal?.throwIfAborted();
            if (recovery && this.worker) { const previous = this.worker; this.worker = undefined; await previous.terminate(); }
            if (!this.worker) {
                this.worker = new Worker(`const {workerData,parentPort}=require('node:worker_threads');
                    import('tsx/esm/api').then(({tsImport})=>tsImport(workerData.entry,${JSON.stringify(import.meta.url)})).catch(e=>{throw e});`,
                { eval: true, workerData: { entry: new URL('./upgradeJournalWorker.ts', import.meta.url).href, root: this.root, lockRoot: this.lockRoot } });
            }
            const worker = this.worker; const id = ++this.sequence; worker.ref();
            try {
                const result = await new Promise<any>((resolve, reject) => {
                    const cleanup = () => { signal?.removeEventListener('abort', abort); worker.off('message', message); worker.off('error', fail); worker.off('exit', exited); };
                    const fail = (error: Error) => { cleanup(); if (this.worker === worker) this.worker = undefined;
                        worker.once('error', () => {});
                        void worker.terminate().then(() => reject(error), reject); };
                    const exited = (code: number) => fail(new Error(`Upgrade storage worker exited (${code}); preserve journal for recovery`));
                    const abort = () => { cleanup(); if (this.worker === worker) this.worker = undefined;
                        worker.once('error', () => {}); // An already-queued worker failure cannot escape intentional retirement.
                        void worker.terminate().then(() => reject(new Error('Upgrade storage stopped; durable state requires readback before continuation'))); };
                    const message = (reply: any) => { if (reply.id !== id) return; cleanup(); if (reply.error) reject(new Error(reply.error)); else resolve(reply.value); };
                    worker.on('message', message); worker.once('error', fail); worker.once('exit', exited); signal?.addEventListener('abort', abort, { once: true });
                    try { worker.postMessage({ id, method, args: args.map(value => this.encode(value)), known: [...this.plans.keys()] }); }
                    catch (error) { cleanup(); reject(error); }
                });
                signal?.throwIfAborted();
                const decoded = await this.decode(result); signal?.throwIfAborted(); return decoded;
            } finally { worker.unref(); }
        });
        this.tail = task;
        return task as Promise<T>;
    }
}
