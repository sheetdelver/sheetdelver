import fs from 'node:fs';
import path from 'node:path';
import { getDataDir, writeOwnerOnlyFileAtomicSync } from '@core/paths';
import { getConfig } from '@core/config';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { serviceAccountAuthority } from '@server/core/world/ServiceAccountAuthority';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { worldWorkGate, withMaintenanceDispatch } from '@server/core/world/WorldWorkGate';
import { primaryDocumentCacheCoordinator } from '@server/core/documents/primary/PrimaryDocumentCacheCoordinator';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { itemStore } from '@server/core/documents/primary/items/ItemStore';
import { sceneStore } from '@server/core/documents/primary/scenes/SceneStore';
import { settingStore, SettingStore } from '@server/core/documents/primary/settings/SettingStore';
import { compendiumStore } from '@server/core/compendium/CompendiumStore';
import { isRecord } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import { moduleWorldContext, ModuleWorldContextService } from '../ModuleWorldContextService';
import { freezeWorldValue } from '@shared/sdk/world';
import { applicableMigrationSteps, discoverMigrations, migrationDirectoryDigest, type ResolvedMigrationCatalog } from '@modules/registry/migrations/catalog';
import { ModuleUpgradeCoordinator, type UpgradeCoordinatorDeps, type UpgradeCandidate } from './ModuleUpgradeCoordinator';
import { UpgradeJournal, type UpgradeJob } from './UpgradeJournal';
import { enumerateMigrationTargets, migrationEnvelope } from './targets';

let journal: UpgradeJournal | null = null;
let journalRoot: string | null = null;
export function getUpgradeJournal(): UpgradeJournal {
    const root = path.join(getDataDir(), 'config', 'module-upgrades');
    if (!journal || journalRoot !== root) {
        journalRoot = root;
        journal = new UpgradeJournal(root, process.env.SHEET_DELVER_MIGRATION_LOCK_DIR || path.join(root, 'leases'));
    }
    return journal;
}
export function restoreUpgradeMaintenance(): void {
    try {
    const completed = getUpgradeJournal().jobs().filter(job => job.phase === 'completed').sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
    if (completed.length) worldWorkGate.activateServingToken(completed.at(-1)!.jobId);
    for (const job of completed) {
        // Completion may have been fsynced immediately before a process died.
        // Reclaim only that same dead job's locks, never another live writer's.
        try { job.leaseToken = getUpgradeJournal().acquire(job); getUpgradeJournal().release(job); } catch { /* another live job/host owns the lease */ }
    }
    for (const job of getUpgradeJournal().jobs()) if (!['completed', 'cancelled'].includes(job.phase)) {
        worldWorkGate.block('module-upgrade', { phase: job.phase, message: 'Module upgrade in progress' });
    }
    } catch {
        // Corrupt durable state must not take the administrative recovery server down.
        worldWorkGate.block('upgrade-journal', { phase: 'recovery-required', message: 'World unavailable — maintenance required' });
    }
}
export function assertMigrationAuthority(): void {
    const id = serviceAccountAuthority.getUserId();
    if (!id || !serviceAccountAuthority.checkCurrent(userStore.get(id))) throw new Error('Full-GM service account required');
    const worldId = worldStateStore.getCurrentWorldId();
    if (!worldId || !worldStateStore.isReady()) throw new Error('Selected running world required; launch it and rerun dry-run');
}
export async function freshMigrationSnapshot(catalog: ResolvedMigrationCatalog) {
    const { systemService } = await import('../SystemService');
    const transport = systemService.getSystemClient();
    assertMigrationAuthority();
    const generation = transport.connectionEpoch;
    const worldId = worldStateStore.getCurrentWorldId();
    const active = moduleWorldContext.snapshot();
    const applicable = applicableMigrationSteps(catalog, active.identity.systemVersion, active.identity.foundryGeneration);
    const kinds = new Set(applicable.flatMap(step => [...step.targets, ...(step.reads?.targets ?? [])]));
    const needsActors = kinds.has('Actor') || kinds.has('Item') || kinds.has('ActiveEffect') || kinds.has('ActorDelta');
    const needsItems = kinds.has('Item') || kinds.has('ActiveEffect');
    const needsPacks = kinds.has('WorldPack') || applicable.some(step => step.reads?.packs?.length);
    const readPacks = applicable.flatMap(step => step.reads?.packs ?? []);
    const packContentStamp = () => {
        const writableScope = kinds.has('WorldPack') ? compendiumStore.listPackMetadata().filter(pack => {
            const type = pack.type ?? pack.documentName ?? pack.entity;
            return pack.id?.startsWith('world.') && (type === 'Actor' || type === 'Item');
        }).map(pack => String(pack.id)) : [];
        return [...new Set([...readPacks, ...writableScope])].sort().map(id => [id, compendiumStore.getPackContentRevision(id)]);
    };
    const stores = [settingStore, userStore, ...(needsActors ? [actorStore] : []), ...(needsItems ? [itemStore] : []), ...(kinds.has('ActorDelta') ? [sceneStore] : [])];
    const stamp = () => JSON.stringify([transport.connectionEpoch, worldStateStore.getCurrentWorldId(), moduleWorldContext.snapshot().identity,
        stores.map(store => store.getMutationRevision()), needsPacks ? compendiumStore.listPackMetadata() : [], packContentStamp()]);
    const before = stamp();
    // These GETs deliberately do not enter FoundryEventIngress. A read-only
    // preview must not replace serving sources, consume context changes or
    // initialize an adapter. Only declared source domains are fetched.
    const read = async (type: string, operation: Record<string, unknown> = {}) => {
        const response = await transport.readDocumentSources(type, { query: {}, ...operation });
        const result = isRecord(response) ? response.result : response;
        if (!Array.isArray(result) || result.some(row => !isRecord(row))) throw new Error(`Migration ${type} source read unavailable`);
        return result as Record<string, unknown>[];
    };
    const actors = needsActors ? await read('Actor') : [];
    const items = needsItems ? await read('Item') : [];
    const scenes = kinds.has('ActorDelta') ? await read('Scene') : [];
    const settings = new SettingStore();
    await settings.seed(async () => await read('Setting') as never);
    const users = await read('User');
    const userId = serviceAccountAuthority.getUserId()!;
    if (!serviceAccountAuthority.checkCurrent(users.find(row => (row._id ?? row.id) === userId) ?? null)) throw new Error('Full-GM service account required');
    const candidateContext = new ModuleWorldContextService(settings);
    candidateContext.configure(getConfig().foundry.url, active.identity, catalog.worldSettings);
    const world = freezeWorldValue({ identity: { ...active.identity }, settings: candidateContext.snapshot().settings });
    const exclusions: string[] = [];
    const requiredSteps = applicable.filter(step => step.required);
    const targets = await enumerateMigrationTargets({ dispatchDocumentSocket: (type, action, operation) => {
        if (action !== 'get') throw new Error('Migration snapshot is read-only');
        return read(type, operation);
    } }, kinds, readPacks, {
        exclusions, requiredKinds: new Set(requiredSteps.flatMap(step => [...step.targets, ...(step.reads?.targets ?? [])])), requiredReadPacks: new Set(requiredSteps.flatMap(step => step.reads?.packs ?? [])),
        view: { actors, items, scenes, packs: compendiumStore.listPackMetadata(), configuration: settings.getValueByKey('core.compendiumConfiguration'),
            subject: userStore.createAccessSubject(userId)!, generation: world.identity.foundryGeneration },
    });
    assertMigrationAuthority();
    const assertCurrent = () => {
        assertMigrationAuthority();
        if (!transport.isConnected || generation !== transport.connectionEpoch || worldId !== worldStateStore.getCurrentWorldId() || before !== stamp()) throw new Error('Migration source scope changed; rerun snapshot');
    };
    assertCurrent();
    return { world, targets, exclusions, assertCurrent };
}

/** Only the gated preparation lifecycle may replace the serving read model. */
export async function reconcileMigrationPreparation(): Promise<() => void> {
    if (!worldWorkGate.hasBlock('module-upgrade') && !worldWorkGate.hasBlock('migration-compatibility')) throw new Error('Migration preparation requires maintenance');
    const { systemService } = await import('../SystemService');
    const publish = await primaryDocumentCacheCoordinator.reconcileAll(systemService.getSystemClient());
    moduleWorldContext.refresh();
    return publish;
}
export function createHostUpgradeCoordinator(overrides: Partial<UpgradeCoordinatorDeps> = {}): ModuleUpgradeCoordinator {
    const unavailable = async () => { throw new Error('Use the archive/source preparation operation for promotion'); };
    const deps: UpgradeCoordinatorDeps = {
        journal: getUpgradeJournal(), gate: worldWorkGate, snapshot: freshMigrationSnapshot, assertAuthority: assertMigrationAuthority,
        write: async (target, updates, fence) => {
            const { systemService } = await import('../SystemService');
            const transport = systemService.getSystemClient();
            const epoch = transport.connectionEpoch;
            const envelope = migrationEnvelope(target, updates);
            await withMaintenanceDispatch(() => {
                fence(); assertMigrationAuthority();
                if (!transport.isConnected || transport.connectionEpoch !== epoch) throw new Error('Migration transport retired');
            }, async () => { await transport.dispatchDocumentSocket(envelope.type, 'update', envelope.operation); });
        },
        promote: unavailable, restart: () => { throw new Error('Restart handler required'); }, prepare: unavailable,
        activate: async (job) => { worldWorkGate.activateServingToken(job.jobId); worldWorkGate.release('migration-compatibility'); },
        rollbackFiles: async (job) => {
            rollbackUpgradeFiles(job, getDataDir());
            const { refreshRegistry } = await import('@modules/registry/server');
            refreshRegistry();
        },
        ...overrides,
    };
    return new ModuleUpgradeCoordinator(deps);
}
/** Recover only deployment files before native intent; this is never a world undo. */
export function rollbackUpgradeFiles(job: UpgradeJob, dataDirectory: string): void {
    if (job.possibleWrite) throw new Error('Cannot roll back files after possible world writes');
    if (!job.sourceDirectory && (!job.targetDirectory || !job.previousDirectory || !job.transactionDirectory)) return;
    if (!job.sourceDirectory && (job.targetDirectory !== path.join(dataDirectory, 'modules', job.moduleId)
        || job.previousDirectory !== path.join(job.transactionDirectory!, 'previous')
        || path.dirname(path.resolve(job.transactionDirectory!)) !== path.join(dataDirectory, 'dist', 'archives')
        || fs.lstatSync(job.transactionDirectory!).isSymbolicLink())) throw new Error('Unexpected rollback paths');
    if (!job.sourceDirectory && fs.existsSync(job.previousDirectory!)) {
        if (fs.existsSync(job.targetDirectory!)) fs.renameSync(job.targetDirectory!, path.join(job.transactionDirectory!, 'cancelled-candidate'));
        fs.renameSync(job.previousDirectory!, job.targetDirectory!);
    } else if (!job.sourceDirectory && fs.existsSync(job.targetDirectory!)
        && migrationDirectoryDigest(job.targetDirectory!) === job.treeDigest
        && ['previous-retained', 'promoted', 'registered'].includes(job.fileTransition ?? '')) {
        fs.renameSync(job.targetDirectory!, path.join(job.transactionDirectory!, 'cancelled-candidate'));
    }
    for (const backup of job.registryBackups ?? []) {
        if (![path.join(dataDirectory, 'modules', 'state.json'), path.join(dataDirectory, 'modules', 'artifacts.json')].includes(path.resolve(backup.path))) throw new Error('Unexpected registry recovery path');
        if (backup.contents !== null) writeOwnerOnlyFileAtomicSync(backup.path, backup.contents);
        else if (fs.existsSync(backup.path)) fs.unlinkSync(backup.path);
    }
}
export function installedUpgradeCandidate(job: UpgradeJob): UpgradeCandidate {
    if (job.sourceDirectory) {
        if (migrationDirectoryDigest(job.sourceDirectory) !== job.sourceDigest) throw new Error('Approved local/source code changed');
        const info = JSON.parse(fs.readFileSync(path.join(job.candidateRoot, 'info.json'), 'utf8'));
        return { moduleId: job.moduleId, version: info.version, root: job.candidateRoot, info, artifactDigest: job.artifactDigest,
            sourceDirectory: job.sourceDirectory, sourceDigest: job.sourceDigest, sourceCategory: job.sourceCategory };
    }
    if (!job.targetDirectory || !fs.existsSync(job.targetDirectory)) throw new Error('Promoted package unavailable; recover retained files');
    const info = JSON.parse(fs.readFileSync(path.join(job.targetDirectory, 'info.json'), 'utf8'));
    if (migrationDirectoryDigest(job.targetDirectory) !== job.treeDigest) throw new Error('Installed candidate digest changed');
    return { moduleId: job.moduleId, version: info.version, root: job.targetDirectory, info, artifactDigest: job.artifactDigest };
}
export function hasPriorWorldMigration(moduleId: string): boolean {
    return getUpgradeJournal().jobs().some(job => job.moduleId === moduleId && job.possibleWrite);
}
export function assertMigrationReplacement(root: string, info: UpgradeCandidate['info']): void {
    const catalog = discoverMigrations(root, info);
    if (!catalog && hasPriorWorldMigration(info.id)) throw new Error('Cannot prove data-read compatibility after prior migrations; catalog required');
}
export function configuredServiceAccountName(): string { return getConfig().foundry.username ?? ''; }

/** Completed jobs retain files until an explicit admin cleanup, never on failure. */
export function cleanupRetainedUpgradeFiles(jobId: string): UpgradeJob {
    const job = getUpgradeJournal().job(jobId);
    if (job.phase !== 'completed') throw new Error('Only completed upgrade files may be cleaned');
    if (job.retainedFiles === 'cleaned') return job;
    const archiveRoot = path.resolve(getDataDir(), 'dist', 'archives');
    for (const directory of [job.transactionDirectory, job.sourceDirectory ? job.candidateRoot : undefined]) {
        if (!directory) continue;
        const resolved = path.resolve(directory);
        if (path.dirname(resolved) !== archiveRoot) throw new Error('Unexpected retained artifact path');
        if (!fs.existsSync(resolved)) continue;
        if (fs.lstatSync(resolved).isSymbolicLink()) throw new Error('Unexpected retained artifact path');
        fs.rmSync(resolved, { recursive: true, force: true });
    }
    job.retainedFiles = 'cleaned'; getUpgradeJournal().save(job);
    return job;
}
