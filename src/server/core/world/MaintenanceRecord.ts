import fs from 'node:fs';
import path from 'node:path';

/** Read-only maintenance state shared by Core and the Next proxy. Callers supply
 * the runtime path; no startup resolution, directory initialization or writes. */
export interface MaintenanceMode {
    schemaVersion: 1;
    id: string;
    stage: 'entering' | 'isolated' | 'planning' | 'review' | 'executing' | 'recovery-required' | 'activating' | 'serving';
    moduleId: string;
    candidateId?: string;
    previewId?: string;
    jobId?: string;
    /** Durable pre-publication intent, never authority to promote or write. */
    initialApproval?: { jobId: string; planId: string; planDigest: string; artifactDigest: string;
        catalogDigest: string; treeDigest: string; idempotencyKey: string; administrator: string };
    leaseToken?: string;
    world?: { instanceId: string; worldId: string; systemId: string };
    failure?: string;
    progress?: { checked: number; total: number; planned: number; stepId?: string; phase?: string; confirmed?: number; uncertain?: number; discovered?: number; remaining?: number; updatedAt: number };
    stoppedWorkers?: number[];
    drained?: boolean;
    diagnosticOnly?: boolean;
    updatedAt: number;
}
export function maintenanceFile(dataDirectory: string): string { return path.join(dataDirectory, 'config/module-upgrades/maintenance.json'); }
// Counters are diagnostics, not admission, approval, drain or receipt evidence.
// A different durable record/process must never inherit a stale local overlay.
export interface MaintenanceProgress { file: string; stamp: string; id: string; stage: MaintenanceMode['stage']; value: NonNullable<MaintenanceMode['progress']> }
export const maintenanceRecordStamp = (stat: fs.Stats) => `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
export function readMaintenanceRecord(file: string, liveProgress?: MaintenanceProgress): MaintenanceMode | null {
    if (!fs.existsSync(file)) return null;
    try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new Error('Invalid persistent maintenance mode; preserve the record for recovery');
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as MaintenanceMode;
    if (value.schemaVersion !== 1 || !/^[a-zA-Z0-9-]{1,128}$/.test(value.id)
        || !['entering', 'isolated', 'planning', 'review', 'executing', 'recovery-required', 'activating', 'serving'].includes(value.stage)
        || typeof value.moduleId !== 'string') throw new Error('Invalid persistent maintenance mode schema');
    if (liveProgress?.file === file && liveProgress.stamp === maintenanceRecordStamp(stat)
        && liveProgress.id === value.id && liveProgress.stage === value.stage) {
        return { ...value, progress: { ...liveProgress.value }, updatedAt: Math.max(value.updatedAt, liveProgress.value.updatedAt) };
    }
    return value;
    } catch {
        return { schemaVersion: 1, id: 'unreadable-maintenance', moduleId: 'unknown', stage: 'recovery-required', diagnosticOnly: true,
            failure: 'Persistent maintenance record is unreadable. Preserve config/module-upgrades and restore a validated operation record before resuming. No world writes are authorized.', updatedAt: 0 };
    }
}
export function maintenanceOnly(mode: MaintenanceMode | null): boolean {
    return !!mode && (!['activating', 'serving'].includes(mode.stage) || mode.drained !== true);
}
