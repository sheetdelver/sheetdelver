import { listModules } from '@modules/registry/server';
import { discoverMigrations } from '@modules/registry/migrations/catalog';
import { moduleWorldContext } from '../ModuleWorldContextService';
import { worldWorkGate } from '@server/core/world/WorldWorkGate';
import { planWorldMigrations } from './planner';
import { assertMigrationAuthority, assertMigrationReplacement, createHostUpgradeCoordinator, getUpgradeJournal, installedUpgradeCandidate } from './ModuleUpgradeService';
import { prepareSourceCandidate } from './sourceCandidates';
import fs from 'node:fs';
import { freshMigrationSnapshot } from './ModuleUpgradeService';
import { sourceHash } from './planner';

let diagnostic: { moduleId: string; blockers: string[]; counts: unknown } | null = null;
export function getMigrationCompatibilityDiagnostic() { return diagnostic; }

/** Fresh required checks run even when local job history says completed. No implicit repair approval. */
export async function checkInstalledWorldCompatibility(systemId: string, prepare: () => Promise<void> = async () => {}): Promise<void> {
    const entry = listModules({ includeExperimental: true, includeDisabled: true }).find(entry => entry.info.id === systemId || entry.info.aliases?.includes(systemId));
    if (!entry) { await prepare(); return; }
    const currentWorld = moduleWorldContext.snapshot();
    const pendingJob = getUpgradeJournal().jobs().find(job => !['completed', 'cancelled'].includes(job.phase)
        && job.moduleId === entry.info.id && job.plan.world.identity.instanceId === currentWorld.identity.instanceId
        && job.plan.world.identity.worldId === currentWorld.identity.worldId);
    if (pendingJob) {
        if (pendingJob.phase === 'recovery-required' || pendingJob.fileTransition !== 'registered') throw new Error('Admin recovery required for interrupted module upgrade');
        await createHostUpgradeCoordinator({ prepare }).resume(pendingJob.jobId, installedUpgradeCandidate(pendingJob));
        return;
    }
    const local = entry.lifecycle.activeSource === 'local';
    diagnostic = null;
    worldWorkGate.block('migration-compatibility', { phase: 'blocked', message: 'World unavailable — maintenance required' });
    let root = entry.directory;
    const declared = discoverMigrations(root, entry.info, local);
    if (!declared) assertMigrationReplacement(root, entry.info);
    if (declared && local) root = (await prepareSourceCandidate(root, entry.info, 'local')).root;
    try {
    const catalog = discoverMigrations(root, entry.info);
    if (!catalog) { await prepare(); worldWorkGate.release('migration-compatibility'); return; }
    worldWorkGate.block('migration-compatibility', { phase: 'blocked', message: 'World unavailable — maintenance required' });
    assertMigrationAuthority();
    const source = await freshMigrationSnapshot(catalog);
    const plan = planWorldMigrations(root, catalog, source.world, source.targets, true);
    diagnostic = plan.blockers.length ? { moduleId: entry.info.id, blockers: plan.blockers, counts: { checked: plan.checked, blocked: plan.blockers.length } } : null;
    if (plan.blockers.length) throw new Error('Module source compatibility requires admin maintenance');
    await prepare();
    const after = await freshMigrationSnapshot(catalog);
    if (sourceHash(source.targets) !== sourceHash(after.targets) || sourceHash(source.world.settings) !== sourceHash(after.world.settings)
        || planWorldMigrations(root, catalog, after.world, after.targets, true).blockers.length) throw new Error('Source compatibility changed during preparation');
    worldWorkGate.release('migration-compatibility');
    } finally {
        // The bootstrap compiled copy is not an approved durable job artifact.
        if (local && root !== entry.directory) fs.rmSync(root, { recursive: true, force: true });
    }
}
