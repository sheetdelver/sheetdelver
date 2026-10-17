import fs from 'node:fs';
import path from 'node:path';
import { listModuleInventory } from '@modules/registry/server';
import { getModulesDataDir } from '@server/core/paths';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { serviceAccountAuthority } from '@server/core/world/ServiceAccountAuthority';
import { worldWorkGate } from '@server/core/world/WorldWorkGate';
import { readMaintenanceMode, maintenanceOnly } from '@server/core/world/MaintenanceMode';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { itemStore } from '@server/core/documents/primary/items/ItemStore';
import { sceneStore } from '@server/core/documents/primary/scenes/SceneStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { compendiumStore } from '@server/core/compendium/CompendiumStore';
import { moduleWorldContext } from '../ModuleWorldContextService';
import { systemService } from '../SystemService';
import { getUpgradeJournal } from './ModuleUpgradeService';
import { sourceHash, migrationReason } from './planner';
import { migrationSourceRevision, readMigrationEvidence, hadMigrationEvidence, type EvidenceSource } from './migrationEvidence';
import type { AdminMigrationOverview, AdminMigrationStatus, MigrationAttentionState } from '@shared/types/adminMigration';
import type { SystemModuleInfo } from '@modules/registry/core/types';

const labels: Record<MigrationAttentionState, string> = { 'no-migrations': 'No migrations declared', unknown: 'World data not checked',
    checking: 'Checking world data', unavailable: 'Check unavailable', 'up-to-date': 'Up to date', required: 'Migration required',
    blocked: 'Migration check blocked', 'in-progress': 'Maintenance in progress', 'recovery-required': 'Recovery required' };
export function migrationAttentionFrame() {
    let identity; let connected = false; let generation = -1;
    try { identity = moduleWorldContext.snapshot().identity; const transport = systemService.getSystemClient(); connected = transport.isConnected; generation = transport.connectionEpoch; } catch { /* Explicitly unavailable, never current. */ }
    const native = worldStateStore.getWorld(), system = worldStateStore.getSystem();
    const aligned = !!identity && native?.id === identity.worldId && system?.id === identity.systemId && system?.version === identity.systemVersion;
    const world = native?.id && system?.id ? { ...identity, worldId: native.id, systemId: system.id, title: native.title || native.id }
        : identity ? { ...identity, title: identity.worldId } : null;
    const revision = sourceHash([identity, native?.id, system, generation, connected, serviceAccountAuthority.isQualified(),
        [actorStore, itemStore, sceneStore, settingStore, userStore].map(store => store.getMutationRevision()),
        compendiumStore.listPackMetadata().map(pack => [pack, compendiumStore.getPackContentRevision(String(pack.id))])]);
    return { world, connected: connected && aligned && serviceAccountAuthority.isQualified() && worldStateStore.isReady(), revision };
}
export function assertMigrationAttentionFrame(revision: string): void {
    const current = migrationAttentionFrame();
    if (!current.connected || current.revision !== revision) throw new Error('World/source evidence changed. Check this world data again.');
}
function result(value: Omit<AdminMigrationStatus, 'label' | 'action'>, action?: AdminMigrationStatus['action']): AdminMigrationStatus {
    const canCheck = value.world && value.source && value.state !== 'no-migrations';
    const kind = value.state === 'required' ? 'review' : 'check';
    return { ...value, label: labels[value.state], action: action ?? (canCheck ? { kind, label: kind === 'review' ? 'Review migration' : 'Check world data',
        href: `/admin/modules?${new URLSearchParams({ module: value.moduleId, source: value.source!, migration: value.scopeKey })}` }
        : { kind: 'none', label: '', href: null }) };
}
/** Warm durable diagnostic read models once on restricted startup, independently
 * of native reconnect. Uses the existing owned storage worker; no scans, hooks,
 * approval, lease mutation or normal registry discovery. Polling remains passive. */
export async function warmMaintenanceMigrationStatus(): Promise<void> {
    const mode = readMaintenanceMode(); if (!mode || mode.stage === 'serving') return;
    const journal = getUpgradeJournal();
    if (mode.candidateId) await journal.sourceCandidate(mode.candidateId);
    if (mode.jobId) await journal.job(mode.jobId);
    if (mode.previewId) await journal.preview(mode.previewId);
}
/** No hooks, native reads, registry/module initialization or full journal loads. */
export function maintenanceMigrationStatus(): AdminMigrationStatus | null {
    let mode = readMaintenanceMode(); const journal = getUpgradeJournal();
    if ((!mode || mode.stage === 'serving') && worldWorkGate.hasBlock('upgrade-journal')) return result({
        moduleId: worldStateStore.getSystem()?.id ?? 'unknown', title: 'Upgrade journal recovery', source: null, version: null,
        world: null, selectedSource: false, activeWorld: true, state: 'recovery-required', catalogDeclared: null,
        reason: 'Durable upgrade evidence is unreadable. Preserve config/module-upgrades and inspect the admin recovery diagnostics.',
        scopeKey: 'unreadable-upgrade-journal',
    }, { kind: 'maintenance', label: 'Review recovery', href: '/admin/modules' });
    if (!mode || mode.stage === 'serving') {
        const pending = journal.peekJobs().find(job => !['completed', 'cancelled'].includes(job.phase));
        if (!pending) return null;
        // Display-only fallback for durable jobs loaded by startup. Never saved
        // as an operation record and never used for approval or execution.
        mode = { schemaVersion: 1, id: pending.jobId, jobId: pending.jobId, moduleId: pending.moduleId,
            stage: pending.phase === 'recovery-required' ? 'recovery-required' : 'executing',
            world: pending.plan.world.identity, failure: pending.failure, updatedAt: Date.now() };
    }
    const job = mode.jobId ? journal.peekJob(mode.jobId) : undefined;
    const candidate = mode.candidateId ? journal.peekSourceCandidate(mode.candidateId) : undefined;
    const preview = mode.previewId ? journal.peekPreview(mode.previewId) : undefined;
    const world = job?.plan.world.identity ?? preview?.plan.world.identity ?? mode.world;
    const source = candidate?.sourceCategory ?? job?.sourceCategory ?? (candidate?.archive || !job?.sourceDirectory && job?.targetDirectory ? 'managed' : null);
    const recovery = mode.stage === 'recovery-required' || mode.diagnosticOnly || job?.phase === 'recovery-required';
    const phase = mode.stage;
    const reasons: Partial<Record<typeof phase, string>> = {
        entering: 'Stopping normal services and waiting for outstanding work to settle.',
        isolated: 'Normal services are stopped. Build the complete world-data plan.',
        planning: 'Checking the complete world inventory. No write approval has been granted.',
        review: 'A complete plan is ready for administrator review. Entering maintenance did not authorize writes.',
        executing: 'Executing the exact approved plan. Keep Foundry running; normal sessions remain paused.',
        activating: 'Verifying fresh preparation and restoring normal service. Do not treat file promotion as completion.',
    };
    return result({ moduleId: mode.moduleId, title: candidate?.info.title ?? mode.moduleId, source,
        version: candidate?.version ?? job?.candidateVersion ?? preview?.candidateVersion ?? null,
        selectedSource: true, activeWorld: true,
        world: world ? { worldId: world.worldId, systemId: world.systemId, instanceId: world.instanceId,
            title: worldStateStore.getWorld()?.id === world.worldId ? worldStateStore.getWorld()?.title || world.worldId : world.worldId } : null,
        state: recovery ? 'recovery-required' : 'in-progress', phase,
        reason: recovery ? mode.failure || job?.failure || 'Maintenance needs administrator recovery. Preserve the journal; no automatic replay or undo.' : reasons[phase] || 'Waiting for verified maintenance state.',
        nextStep: mode.drained !== true ? 'Reconcile outstanding ordinary write outcomes before leaving maintenance. Cancellation cannot bypass an unproven drain.'
            : recovery ? mode.jobId ? 'Inspect the recovery details. Reconcile the approved job or review changed source; stopping cannot undo world writes.'
                : 'Inspect the failure, then rebuild the authoritative plan or cancel before writes. No new approval has been granted.'
                : phase === 'review' ? 'Review the complete plan, acknowledge the backup warning, then approve this exact plan.'
                    : ['entering', 'planning', 'executing', 'activating'].includes(phase) ? 'Keep Foundry running and wait for this phase to settle. Only verified activation reopens world access.'
                        : 'Build the authoritative plan before approving any changes.',
        scopeKey: sourceHash([mode.id, mode.jobId, mode.previewId, phase]), catalogDeclared: true,
        artifactDigest: preview?.artifactDigest ?? job?.artifactDigest, catalogDigest: preview?.catalogDigest ?? job?.catalogDigest,
        ...(preview ? { checked: preview.plan.checked, proposedWrites: preview.plan.operations.length, previewId: preview.id }
            : job ? { checked: job.plan.checked, proposedWrites: job.plan.operations.length } : {}), progress: mode.progress,
    }, { kind: 'maintenance', label: recovery ? 'Review recovery' : phase === 'review' ? 'Review exact plan' : 'View maintenance', href: '/admin' });
}
export function readAdminMigrationOverview(): AdminMigrationOverview {
    const maintenance = maintenanceMigrationStatus();
    // The restricted composition must never discover/import normal module code.
    if (maintenanceOnly()) return { generatedAt: Date.now(), revision: sourceHash(maintenance), sources: [], active: null, maintenance };
    const frame = migrationAttentionFrame(); const sources: AdminMigrationStatus[] = [];
    for (const entry of listModuleInventory()) {
        const candidates: Array<[EvidenceSource['source'], string]> = [];
        if (entry.lifecycle.localDirectory) candidates.push(['local', entry.lifecycle.localDirectory]);
        if (entry.managed) candidates.push(['managed', path.join(getModulesDataDir(), entry.info.id)]);
        if (!candidates.length) candidates.push([entry.lifecycle.activeSource === 'local' ? 'local' : 'managed', entry.directory]);
        for (const [source, directory] of candidates) {
            let info: SystemModuleInfo | undefined; let declared: boolean | null = null; let failure: string | undefined;
            try {
                const file = path.join(directory, 'info.json'); const stat = fs.lstatSync(file);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw new Error('Source manifest is unreadable');
                info = JSON.parse(fs.readFileSync(file, 'utf8')); if (info?.id !== entry.info.id) throw new Error('Source manifest identity changed');
                try { const catalog = fs.lstatSync(path.join(directory, 'migration.json')); if (!catalog.isFile() || catalog.isSymbolicLink()) throw new Error('Catalog is not a regular file'); declared = true; }
                catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') declared = false; else throw error; }
            } catch (error) { failure = migrationReason(error); }
            const descriptor = { moduleId: entry.info.id, source, directory, version: info?.version };
            const sourceRevision = migrationSourceRevision(descriptor);
            const activeWorld = !!frame.world && [entry.info.id, ...(info?.aliases ?? [])].includes(frame.world.systemId);
            const selectedSource = entry.lifecycle.activeSource === source;
            const current = readMigrationEvidence(descriptor);
            let state: MigrationAttentionState = 'unknown'; let reason = 'No fresh check for this source/world. Job history and Enabled status are not readiness evidence.';
            if (!current && hadMigrationEvidence(descriptor)) reason = 'Previous check evidence is stale for the observed world/source revisions. Check world data again.';
            if (failure) { state = 'blocked'; reason = failure; }
            else if (current?.state === 'blocked' && frame.connected && activeWorld) { state = 'blocked'; reason = current.reason; }
            else if (declared === false) { state = 'no-migrations'; reason = 'This source declares no migration catalog. This is not validation of all world data.'; }
            else if (!frame.connected || !activeWorld) { state = 'unavailable'; reason = !frame.connected ? 'The world is unavailable or its service identity/context is not ready. Reconnect before checking.' : 'The running world uses another system. Launch the matching world to check this source.'; }
            else if (current) { state = current.state; reason = current.reason; }
            sources.push(result({ moduleId: entry.info.id, title: info?.title ?? entry.info.title, source, version: info?.version ?? null,
                selectedSource, activeWorld: activeWorld && selectedSource,
                world: frame.world, scopeKey: sourceHash([sourceRevision, frame.revision, entry.lifecycle.activeSource, entry.enabled]), state, reason, catalogDeclared: declared,
                ...(current && frame.connected && activeWorld ? { checkedAt: current.state === 'checking' ? undefined : current.checkedAt, checked: current.checked, proposedWrites: current.proposedWrites,
                    previewId: current.previewId, artifactDigest: current.artifactDigest, catalogDigest: current.catalogDigest } : {}),
            }, !frame.connected || !activeWorld ? { kind: 'none', label: '', href: null } : undefined));
        }
    }
    return { generatedAt: Date.now(), revision: sourceHash([frame.revision, sources, maintenance]), sources,
        active: sources.find(source => source.activeWorld) ?? null, maintenance };
}
export function exactMigrationStatus(moduleId: string, source: 'local' | 'managed', scopeKey?: string): AdminMigrationStatus {
    const current = readAdminMigrationOverview().sources.find(row => row.moduleId === moduleId && row.source === source);
    if (!current || scopeKey && current.scopeKey !== scopeKey) throw new Error('This source/world review link is stale or unavailable. Reopen the current source review.');
    return current;
}
