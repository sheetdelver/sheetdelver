import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { getDataDir, ensureOwnerOnlyDirectorySync, writeOwnerOnlyFileAtomicSync } from '../paths';

export interface MaintenanceMode {
    schemaVersion: 1;
    id: string;
    stage: 'entering' | 'isolated' | 'planning' | 'review' | 'executing' | 'recovery-required' | 'activating' | 'serving';
    moduleId: string;
    candidateId?: string;
    previewId?: string;
    jobId?: string;
    leaseToken?: string;
    world?: { instanceId: string; worldId: string; systemId: string };
    failure?: string;
    progress?: { checked: number; total: number; planned: number; stepId?: string; phase?: string; confirmed?: number; uncertain?: number; discovered?: number; remaining?: number; updatedAt: number };
    stoppedWorkers?: number[];
    drained?: boolean;
    diagnosticOnly?: boolean;
    updatedAt: number;
}
export function maintenanceFile(): string { return path.join(getDataDir(), 'config/module-upgrades/maintenance.json'); }
export function readMaintenanceMode(): MaintenanceMode | null {
    const file = maintenanceFile();
    if (!fs.existsSync(file)) return null;
    try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new Error('Invalid persistent maintenance mode; preserve the record for recovery');
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as MaintenanceMode;
    if (value.schemaVersion !== 1 || !/^[a-zA-Z0-9-]{1,128}$/.test(value.id)
        || !['entering', 'isolated', 'planning', 'review', 'executing', 'recovery-required', 'activating', 'serving'].includes(value.stage)
        || typeof value.moduleId !== 'string') throw new Error('Invalid persistent maintenance mode schema');
    return value;
    } catch {
        return { schemaVersion: 1, id: 'unreadable-maintenance', moduleId: 'unknown', stage: 'recovery-required', diagnosticOnly: true,
            failure: 'Persistent maintenance record is unreadable. Preserve config/module-upgrades and restore a validated operation record before resuming. No world writes are authorized.', updatedAt: 0 };
    }
}
export function saveMaintenanceMode(mode: MaintenanceMode): void {
    const file = maintenanceFile(); ensureOwnerOnlyDirectorySync(path.dirname(file));
    if (mode.diagnosticOnly && fs.existsSync(file)) throw new Error('Diagnostic-only maintenance cannot overwrite the existing record');
    mode.updatedAt = Date.now();
    writeOwnerOnlyFileAtomicSync(file, JSON.stringify(mode));
    if (process.platform !== 'win32') { const fd = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
}
export function maintenanceOnly(mode = readMaintenanceMode()): boolean { return !!mode && !['activating', 'serving'].includes(mode.stage); }
let enforced = false;
export function enforceMaintenanceComposition(): void { enforced = true; }
export function maintenanceCompositionEnforced(): boolean { return enforced; }
let computationSignal: AbortSignal | undefined;
export function setMaintenanceComputationSignal(signal?: AbortSignal): void { computationSignal = signal; }
export function getMaintenanceComputationSignal(): AbortSignal | undefined { return computationSignal; }

/** Existing approved 0.19 jobs keep their approval, but enter the new composition. */
export function restoreLegacyMaintenanceMode(): void {
    if (readMaintenanceMode()) return;
    const jobs = path.join(getDataDir(), 'config/module-upgrades/jobs');
    if (!fs.existsSync(jobs)) return;
    for (const file of fs.readdirSync(jobs).filter(name => /^[a-zA-Z0-9-]+\.json$/.test(name))) {
        try {
        const job = JSON.parse(fs.readFileSync(path.join(jobs, file), 'utf8'));
        if (['completed', 'cancelled'].includes(job.phase)) continue;
        if (!job.jobId || !job.moduleId || !job.plan?.world?.identity) throw new Error('Invalid legacy pending job; normal composition blocked');
        saveMaintenanceMode({ schemaVersion: 1, id: job.jobId, jobId: job.jobId, moduleId: job.moduleId,
            stage: job.phase === 'recovery-required' ? 'recovery-required' : 'executing',
            world: job.plan.world.identity, leaseToken: job.leaseToken, updatedAt: Date.now() });
        return;
        } catch {
            saveMaintenanceMode({ schemaVersion: 1, id: 'unreadable-journal', moduleId: 'unknown', stage: 'recovery-required', diagnosticOnly: true,
                failure: 'Upgrade journal is unreadable. Preserve config/module-upgrades, restore validated records and restart. Ordinary runtime and writes remain stopped.', updatedAt: Date.now() });
            return;
        }
    }
}

/** One Core composition per data directory. No TTL or cross-host lock stealing. */
export function acquireCoreRuntimeLease(scope: 'core' | 'manager' = 'core'): () => void {
    const directory = path.join(getDataDir(), `config/${scope}-runtime.lock`);
    ensureOwnerOnlyDirectorySync(path.dirname(directory));
    const file = path.join(directory, 'owner.json');
    const owner = { host: os.hostname(), pid: process.pid, token: randomUUID() };
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const recovery = `${directory}.recovery`; fs.mkdirSync(recovery, { mode: 0o700 });
        try {
            const old = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof owner;
            if (old.host !== owner.host) throw new Error('Another host owns the Core runtime lease');
            let alive = true;
            try { process.kill(old.pid, 0); } catch (failure) { alive = (failure as NodeJS.ErrnoException).code !== 'ESRCH'; }
            if (alive) throw new Error('Another live Core owns this data directory');
            writeOwnerOnlyFileAtomicSync(file, JSON.stringify(owner));
        } finally { fs.rmdirSync(recovery); }
    }
    if (!fs.existsSync(file)) writeOwnerOnlyFileAtomicSync(file, JSON.stringify(owner));
    return () => {
        try { const current = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof owner;
            if (current.token === owner.token) { fs.unlinkSync(file); fs.rmdirSync(directory); }
        } catch { /* A crash leaves a dead-PID lease for explicit same-host takeover. */ }
    };
}
