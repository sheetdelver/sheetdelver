import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDir } from '@server/core/paths';
import type { AdminMigrationStatus } from '@shared/types/adminMigration';
import { sourceHash, migrationReason } from './planner';
import { inspectLocalModuleInputs } from '@modules/registry/migrations/sourceInspection';

export interface EvidenceSource { moduleId: string; source: 'local' | 'managed'; directory: string; version?: string }
interface Observation { revision: string; watchers: fs.FSWatcher[]; error?: string }
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
    for (const observation of observations.values()) for (const watcher of observation.watchers) watcher.close();
    observations.clear(); evidence.clear(); root = getDataDir();
}
/** Passive, unref'ed filesystem observations only. Never evaluates hooks/scans
 * world data or creates a writer. Process replacement closes these observers. */
function observe(source: EvidenceSource): Observation {
    resetScope(); const id = key(source); let observation = observations.get(id);
    if (!observation) {
        observation = { revision: randomUUID(), watchers: [] }; observations.set(id, observation);
        try {
            const current = observation;
            if (source.source === 'local') {
                watchLocalInputs(source, current, ['info.json', 'migration.json'], []);
                return current;
            }
            const watcher = fs.watch(source.directory, { recursive: true, persistent: false }, (_event, file) => {
                if (file && /(?:^|\/)(?:\.git|node_modules)(?:\/|$)/.test(String(file))) return;
                current.revision = randomUUID();
            });
            watcher.on('error', error => { current.revision = randomUUID(); current.error = migrationReason(error); });
            current.watchers.push(watcher);
        } catch (error) { observation.error = migrationReason(error); }
    }
    return observation;
}
/** Watch selected inputs and their possible resolution replacements. No
 * recursive checkout watcher and no dependency compilation during status GETs. */
function watchLocalInputs(source: EvidenceSource, observation: Observation, inputs: string[], resources: string[]): void {
    const files = new Set(['info.json', 'migration.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'jsconfig.json']);
    const parents = new Set<string>(['.']);
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];
    for (const file of inputs) {
        files.add(file);
        const extension = path.extname(file);
        if (extensions.includes(extension)) {
            const stem = file.slice(0, -extension.length);
            for (const ext of extensions) files.add(stem + ext);
            if (path.basename(stem) === 'index') for (const ext of extensions) files.add(path.dirname(stem) + ext);
        }
        let parent = path.posix.dirname(file);
        while (parent !== '.') {
            for (const name of ['package.json', 'tsconfig.json', 'jsconfig.json']) files.add(`${parent}/${name}`);
            parent = path.posix.dirname(parent);
        }
    }
    files.add('src/styles/tailwind.css');
    for (const file of [...files, ...resources]) {
        let parent = path.posix.dirname(file);
        while (parent !== '.') { parents.add(parent); parent = path.posix.dirname(parent); }
    }
    const affects = (file: string) => files.has(file)
        || [...files].some(input => input.startsWith(`${file}/`))
        || resources.some(resource => file === resource || file.startsWith(`${resource}/`) || resource.startsWith(`${file}/`));
    const replacements: fs.FSWatcher[] = [];
    const watch = (relative: string, recursive: boolean) => {
        let stat: fs.Stats;
        try { stat = fs.lstatSync(path.join(source.directory, relative)); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) return;
        const watcher = fs.watch(path.join(source.directory, relative), { recursive, persistent: false }, (_event, file) => {
            const changed = file ? path.posix.join(relative, String(file).split(path.sep).join('/')) : null;
            if (changed === null || affects(changed)) observation.revision = randomUUID();
        });
        watcher.on('error', error => { observation.revision = randomUUID(); observation.error = migrationReason(error); });
        replacements.push(watcher);
    };
    try {
        for (const parent of parents) watch(parent, false);
        for (const resource of resources) watch(resource, true);
    } catch (error) {
        for (const watcher of replacements) watcher.close();
        throw error;
    }
    for (const watcher of observation.watchers) watcher.close();
    observation.watchers = replacements;
    delete observation.error;
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
        if (source.source === 'local') {
            const observation = observe(source);
            try {
                const inputs = inspectLocalModuleInputs(source.directory);
                watchLocalInputs(source, observation, inputs.files, inputs.resources);
            } catch {
                // The explicit check records malformed/unavailable inputs as a
                // blocked result. Keep the previous observers until a fresh check.
            }
        }
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
