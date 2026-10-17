import { readMaintenanceMode, saveMaintenanceMode, type MaintenanceMode } from '@server/core/world/MaintenanceMode';
import type { UpgradeJob } from './UpgradeJournal';
import type { UpgradeJournalAccess } from './AsyncUpgradeJournal';

type Publication = NonNullable<MaintenanceMode['initialApproval']>;
function identity(job: UpgradeJob): Publication {
    return { jobId: job.jobId, planId: job.id, planDigest: job.plan.digest, artifactDigest: job.artifactDigest,
        catalogDigest: job.catalogDigest, treeDigest: job.treeDigest, idempotencyKey: job.idempotencyKey, administrator: job.administrator };
}
function matches(left: Publication, right: Publication): boolean {
    return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, value]) => value === right[key as keyof Publication]);
}
function assertIntent(mode: MaintenanceMode, intent: Publication): void {
    if (mode.diagnosticOnly || mode.id !== intent.jobId || mode.previewId !== intent.planId
        || !mode.initialApproval || !matches(mode.initialApproval, intent)) throw new Error('First approval operation/identity changed; preserve maintenance for recovery');
}
/** Persisted before the first job save. No file/native work may precede binding. */
export function beginMaintenanceApproval(job: UpgradeJob): void {
    const mode = readMaintenanceMode();
    if (!mode || mode.id !== job.jobId || mode.moduleId !== job.moduleId || mode.jobId || mode.initialApproval
        || mode.previewId !== job.id || mode.stage !== 'executing' || mode.leaseToken !== job.leaseToken) throw new Error('First approval requires the exact maintenance operation and lease');
    mode.initialApproval = identity(job); saveMaintenanceMode(mode);
}
function settle(mode: MaintenanceMode, intent: Publication, durable: UpgradeJob | null): void {
    assertIntent(mode, intent);
    if (durable) {
        if (!matches(intent, identity(durable)) || durable.moduleId !== mode.moduleId || durable.leaseToken !== mode.leaseToken
            || durable.phase !== 'quiescing' || durable.possibleWrite || durable.fileTransition
            || Object.keys(durable.outcomes).length || durable.transactionDirectory) throw new Error('First approval evidence is inconsistent; retain journal and maintenance');
        mode.jobId = durable.jobId;
    } else if (mode.jobId) throw new Error('Previously bound approval is missing; retain maintenance and evidence');
    delete mode.initialApproval;
    saveMaintenanceMode(mode);
}
export function settleMaintenanceApproval(expected: UpgradeJob, durable: UpgradeJob | null): void {
    const mode = readMaintenanceMode();
    if (!mode || mode.id !== expected.jobId) throw new Error('First approval operation retired');
    // Binding may have committed before its own acknowledgement failed.
    if (!mode.initialApproval && mode.jobId === expected.jobId && durable && matches(identity(expected), identity(durable))) return;
    settle(mode, identity(expected), durable);
}
/** Used before controller actions and during startup, before transport/lease
 * takeover. A published binding without this provisional intent is never cleared. */
export async function reconcileMaintenanceApproval(journal: UpgradeJournalAccess): Promise<void> {
    const before = readMaintenanceMode(); const intent = before?.initialApproval;
    if (!before || !intent) return;
    assertIntent(before, intent);
    const durable = await journal.recoverJob(intent.jobId);
    const mode = readMaintenanceMode();
    if (!mode || mode.id !== before.id || mode.leaseToken !== before.leaseToken) throw new Error('First approval ownership changed during recovery');
    settle(mode, intent, durable);
}
