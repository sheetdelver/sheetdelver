import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDir } from '@server/core/paths';
import type { AdminMigrationStatus } from '@shared/types/adminMigration';
import { sourceHash, migrationReason } from './planner';

export interface EvidenceSource { moduleId: string; source: 'local' | 'managed'; directory: string; version?: string }
interface Observation { revision: string; watcher?: fs.FSWatcher; error?: string }
export interface MigrationEvidence {
    state: 'checking' | 'up-to-date' | 'required' | 'blocked' | 'unavailable';
    reason: string; checkedAt: number; checked?: number; proposedWrites?: number;
    previewId?: string; artifactDigest?: string; catalogDigest?: string;
    world: NonNullable<AdminMigrationStatus['world']>;
    assertCurrent: () => void;
    sourceRevision: string;
    run: string;
}
let root = '';
const observations = new Map<string, Observation>();
const evidence = new Map<string, MigrationEvidence>();
function key(source: EvidenceSource): string { return `${source.moduleId}:${source.source}:${path.resolve(source.directory)}`; }
function resetScope(): void {
    if (root === getDataDir()) return;
    for (const observation of observations.values()) observation.watcher?.close();
    observations.clear(); evidence.clear(); root = getDataDir();
}
/** Passive, unref'ed filesystem observations only. Never evaluates hooks/scans
 * world data or creates a writer. Process replacement closes these observers. */
function observe(source: EvidenceSource): Observation {
    resetScope(); const id = key(source); let observation = observations.get(id);
    if (!observation) {
        observation = { revision: randomUUID() }; observations.set(id, observation);
        try {
            const current = observation;
            current.watcher = fs.watch(source.directory, { recursive: true, persistent: false }, (_event, file) => {
                if (file && /(?:^|\/)(?:\.git|node_modules)(?:\/|$)/.test(String(file))) return;
                current.revision = randomUUID();
            });
            current.watcher.on('error', error => { current.revision = randomUUID(); current.error = migrationReason(error); });
        } catch (error) { observation.error = migrationReason(error); }
    }
    return observation;
}
export function migrationSourceRevision(source: EvidenceSource): string {
    const observation = observe(source);
    const stamp = (file: string) => { try { const stat = fs.lstatSync(path.join(source.directory, file));
        return [stat.ino, stat.mtimeMs, stat.ctimeMs, stat.size, stat.isSymbolicLink()]; } catch { return null; } };
    return sourceHash([source, observation.revision, stamp('info.json'), stamp('migration.json')]);
}
export function readMigrationEvidence(source: EvidenceSource): MigrationEvidence | null {
    resetScope(); const value = evidence.get(key(source)); if (!value) return null;
    try {
        if (observe(source).error || value.sourceRevision !== migrationSourceRevision(source)) return null;
        value.assertCurrent();
        return value;
    } catch { return null; }
}
export function hadMigrationEvidence(source: EvidenceSource): boolean { resetScope(); return evidence.has(key(source)); }
/** Diagnostic observer: failures must not alter compatibility/approval behavior. */
export function beginMigrationEvidence(source: EvidenceSource, world: MigrationEvidence['world'], assertCurrent: () => void) {
    let run = ''; let sourceRevision = '';
    try {
        run = randomUUID(); sourceRevision = migrationSourceRevision(source);
        evidence.set(key(source), { run, sourceRevision, world, assertCurrent, state: 'checking',
            checkedAt: Date.now(), reason: 'Checking this source against the current world.' });
    } catch { /* Lack of observations never establishes current readiness. */ }
    return {
        finish(result: Pick<MigrationEvidence, 'state' | 'reason'> & Partial<Pick<MigrationEvidence, 'checked' | 'proposedWrites' | 'previewId' | 'artifactDigest' | 'catalogDigest'>>, fresh = assertCurrent) {
            try {
                if (!run || evidence.get(key(source))?.run !== run || sourceRevision !== migrationSourceRevision(source) || observe(source).error) return;
                fresh(); evidence.set(key(source), { run, sourceRevision, world, assertCurrent: fresh, checkedAt: Date.now(), ...result });
            } catch { /* Stale results must never publish green evidence. */ }
        },
    };
}
