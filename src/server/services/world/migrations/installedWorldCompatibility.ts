import { listModules } from '@modules/registry/server';
import { discoverMigrations } from '@modules/registry/migrations/catalog';
import { moduleWorldContext } from '../ModuleWorldContextService';
import { worldWorkGate } from '@server/core/world/WorldWorkGate';
import { computeWorldMigrations } from './compute';
import { migrationReason } from './planner';
import { assertMigrationAuthority, assertMigrationReplacement, createHostUpgradeCoordinator, getUpgradeJournal, installedUpgradeCandidate, reconcileMigrationPreparation } from './ModuleUpgradeService';
import { prepareSourceCandidate } from './sourceCandidates';
import fs from 'node:fs';
import { freshMigrationSnapshot } from './ModuleUpgradeService';
import { sourceHash } from './planner';
import { beginMigrationEvidence } from './migrationEvidence';
import { migrationAttentionFrame, assertMigrationAttentionFrame } from './migrationAttention';

let diagnostic: { moduleId: string; worldId?: string; phase: string; blockers: string[]; counts?: unknown; remediation: string } | null = null;
let requestMaintenance: ((moduleId: string, directory: string, local: boolean) => Promise<void>) | undefined;
export function setCompatibilityMaintenanceHandler(handler: typeof requestMaintenance): void { requestMaintenance = handler; }
export function getMigrationCompatibilityDiagnostic() { return diagnostic; }

/** Fresh required checks run even when local job history says completed. No implicit repair approval. */
export async function checkInstalledWorldCompatibility(systemId: string, prepare: () => Promise<void> = async () => {}, options: { readOnlyPreparation?: boolean } = {}): Promise<void> {
    const entry = listModules({ includeExperimental: true, includeDisabled: true }).find(entry => entry.info.id === systemId || entry.info.aliases?.includes(systemId));
    if (!entry) { await prepare(); return; }
    let root = entry.directory;
    const local = entry.lifecycle.activeSource === 'local';
    const initialFrame = migrationAttentionFrame();
    const observation = initialFrame.world ? beginMigrationEvidence({ moduleId: entry.info.id,
        source: local ? 'local' : 'managed', directory: entry.directory, version: entry.info.version },
    initialFrame.world, () => assertMigrationAttentionFrame(initialFrame.revision)) : null;
    let phase = 'discovery';
    let classified = false;
    let artifactDigest = entry.artifact?.integrity;
    let publish: (() => void) | undefined;
    const prepareServing = async () => {
        phase = 'preparation';
        publish = await reconcileMigrationPreparation();
        await prepare();
    };
    diagnostic = null;
    worldWorkGate.block('migration-compatibility', { phase: 'blocked', message: 'World unavailable — maintenance required' });
    try {
    const currentWorld = moduleWorldContext.snapshot();
    const pendingJob = (await getUpgradeJournal().jobs()).find(job => !['completed', 'cancelled'].includes(job.phase)
        && job.moduleId === entry.info.id && job.plan.world.identity.instanceId === currentWorld.identity.instanceId
        && job.plan.world.identity.worldId === currentWorld.identity.worldId);
    if (options.readOnlyPreparation) {
        if (!pendingJob || pendingJob.phase !== 'verifying') throw new Error('Isolated preparation requires a verifying approved job');
        getUpgradeJournal().assertLease(pendingJob);
    }
    if (pendingJob && !options.readOnlyPreparation) {
        phase = 'approved-job-recovery';
        if (pendingJob.phase === 'recovery-required' || pendingJob.fileTransition !== 'registered') throw new Error('Admin recovery required for interrupted module upgrade');
        await createHostUpgradeCoordinator({ prepare: prepareServing }).resume(pendingJob.jobId, installedUpgradeCandidate(pendingJob));
        publish?.();
        return;
    }
    const declared = discoverMigrations(root, entry.info, local);
    if (!declared) await assertMigrationReplacement(root, entry.info);
    if (declared && local) { const candidate = await prepareSourceCandidate(root, entry.info, 'local'); root = candidate.root; artifactDigest = candidate.artifactDigest; }
    const catalog = discoverMigrations(root, entry.info);
    if (!catalog) { phase = 'preparation'; await prepare(); worldWorkGate.release('migration-compatibility'); return; }
    worldWorkGate.block('migration-compatibility', { phase: 'blocked', message: 'World unavailable — maintenance required' });
    assertMigrationAuthority();
    phase = 'source-check';
    const source = await freshMigrationSnapshot(catalog);
    const plan = await computeWorldMigrations(root, catalog, source.world, source.targets, true);
    source.assertCurrent();
    if (plan.blockers.length) { classified = true; observation?.finish({ state: plan.diagnostics?.some(row => catalog.steps.find(step => step.id === row.stepId)?.required) ? 'blocked' : 'required',
        reason: plan.blockers[0], checked: plan.checked, artifactDigest, catalogDigest: catalog.digest }, source.assertCurrent); }
    diagnostic = plan.blockers.length ? { moduleId: entry.info.id, worldId: source.world.identity.worldId, phase, blockers: plan.blockers,
        remediation: 'Preview and approve maintenance for this exact running world in the module source or catalog controls.', counts: { checked: plan.checked, blocked: plan.blockers.length } } : null;
    if (plan.blockers.length) {
        await requestMaintenance?.(entry.info.id, entry.directory, local);
        throw new Error('Module source compatibility requires admin maintenance');
    }
    await prepareServing();
    phase = 'post-preparation-source-check';
    const after = await freshMigrationSnapshot(catalog);
    if (sourceHash(source.targets) !== sourceHash(after.targets) || sourceHash(source.world.settings) !== sourceHash(after.world.settings)
        || (await computeWorldMigrations(root, catalog, after.world, after.targets, true)).blockers.length) throw new Error('Source compatibility changed during preparation');
    after.assertCurrent();
    assertMigrationAuthority();
    worldWorkGate.release('migration-compatibility');
    publish?.();
    const readyFrame = migrationAttentionFrame();
    observation?.finish({ state: 'up-to-date', reason: 'Current source compatibility passed fresh checks and preparation.',
        checked: plan.checked, artifactDigest, catalogDigest: catalog.digest }, () => { after.assertCurrent(); assertMigrationAttentionFrame(readyFrame.revision); });
    } catch (error) {
        if (!classified) observation?.finish({ state: 'blocked', reason: migrationReason(error) });
        diagnostic ??= { moduleId: entry.info.id, phase, blockers: [migrationReason(error)],
            remediation: 'Inspect the Core error log and module migration files, confirm the selected world is running, then retry world preparation. No repair is authorized by retrying.' };
        throw error;
    } finally {
        // The bootstrap compiled copy is not an approved durable job artifact.
        if (local && root !== entry.directory) fs.rmSync(root, { recursive: true, force: true });
    }
}
