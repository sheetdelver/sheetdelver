import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { getDataDir, ensureOwnerOnlyDirectorySync, writeOwnerOnlyFileAtomicSync } from '../paths';

import {
    maintenanceFile as recordFile, maintenanceOnly as recordRequiresMaintenance,
    readMaintenanceRecord, maintenanceRecordStamp,
    type MaintenanceMode, type MaintenanceProgress,
} from './MaintenanceRecord';
export type { MaintenanceMode } from './MaintenanceRecord';

export function maintenanceFile(dataDirectory = getDataDir()): string { return recordFile(dataDirectory); }
let liveProgress: MaintenanceProgress | undefined;
export function readMaintenanceMode(file = maintenanceFile()): MaintenanceMode | null {
    return readMaintenanceRecord(file, liveProgress);
}
/** Responsive process-local progress. Durable transitions checkpoint the latest
 * snapshot; a crash reconstructs authority/counts from the complete journal. */
export function reportMaintenanceProgress(progress: NonNullable<MaintenanceMode['progress']>): void {
    const mode = readMaintenanceMode();
    if (!mode || mode.diagnosticOnly || !maintenanceOnly(mode)) return;
    const file = maintenanceFile();
    liveProgress = { file, stamp: maintenanceRecordStamp(fs.lstatSync(file)), id: mode.id, stage: mode.stage, value: Object.freeze({ ...progress }) };
}
export function saveMaintenanceMode(mode: MaintenanceMode): void {
    if (['activating', 'serving'].includes(mode.stage)) assertMaintenanceDrained(mode);
    const file = maintenanceFile(); ensureOwnerOnlyDirectorySync(path.dirname(file));
    if (mode.diagnosticOnly && fs.existsSync(file)) throw new Error('Diagnostic-only maintenance cannot overwrite the existing record');
    mode.updatedAt = Date.now();
    writeOwnerOnlyFileAtomicSync(file, JSON.stringify(mode));
    if (process.platform !== 'win32') { const fd = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    liveProgress = undefined;
}
export function assertMaintenanceDrained(mode: MaintenanceMode): void {
    if (mode.diagnosticOnly || mode.drained !== true) throw new Error('Ordinary native write outcomes remain unknown: a proven drain is required before leaving maintenance. Preserve the lease and reconcile outcomes.');
}
export function maintenanceOnly(mode = readMaintenanceMode()): boolean {
    return recordRequiresMaintenance(mode);
}
let enforced = false;
export function enforceMaintenanceComposition(): void { enforced = true; }
export function maintenanceCompositionEnforced(): boolean { return enforced; }
let computationSignal: AbortSignal | undefined;
export function setMaintenanceComputationSignal(signal?: AbortSignal): void { computationSignal = signal; }
export function getMaintenanceComputationSignal(): AbortSignal | undefined { return computationSignal; }

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
