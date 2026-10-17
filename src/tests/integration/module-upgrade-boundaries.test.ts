import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { fixture, world } from '../unit/world/module-world-migrations.test';
import { WorldBootstrapper } from '@server/services/world/WorldBootstrapper';
import { CoreSocket } from '@server/core/foundry/sockets/CoreSocket';
import { FoundryEventIngress } from '@server/services/world/FoundryEventIngress';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { itemStore } from '@server/core/documents/primary/items/ItemStore';
import { sceneStore } from '@server/core/documents/primary/scenes/SceneStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { moduleWorldContext } from '@server/services/world/ModuleWorldContextService';
import { serviceAccountAuthority } from '@server/core/world/ServiceAccountAuthority';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { worldWorkGate, dispatchCoreMutation, withMaintenanceDispatch, withWorldWorkScope, dispatchWorldWork } from '@server/core/world/WorldWorkGate';
import { ModuleUpgradeCoordinator } from '@server/services/world/migrations/ModuleUpgradeCoordinator';
import { UpgradeJournal } from '@server/services/world/migrations/UpgradeJournal';
import { enumerateMigrationTargets, migrationEnvelope } from '@server/services/world/migrations/targets';
import { applyMigrationPatch, planWorldMigrations } from '@server/services/world/migrations/planner';
import { discoverMigrations } from '@modules/registry/migrations/catalog';
import { prepareModuleArchive, promotePreparedModuleArchive } from '@modules/registry/distribution/archiveTransaction';
import { packageMigrations } from '@modules/registry/migrations/compile';
import { createModuleReleaseManifest } from '@modules/registry/distribution/releaseManifest';
import { migrationSummary } from '@modules/registry/migrations/catalog';
import { compendiumStore } from '@server/core/compendium/CompendiumStore';
import { preparedActorStore } from '@server/core/documents/prepared/actors/PreparedActorStore';
import { rollbackUpgradeFiles } from '@server/services/world/migrations/ModuleUpgradeService';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Real Core dispatch/ingress and Stores; only the upstream wire and process restart are controlled. */
class OfflineCoreSocket extends CoreSocket {
    constructor(private readonly native: Map<string, Record<string, unknown>>, readonly calls: string[]) {
        super({ url: 'http://offline.invalid', username: 'service' });
        this.userId = 'service'; this.isSocketConnected = true;
        this.socket = {
            connected: true,
            emit: (event: string, payload: { type: string; action: string; operation: { updates: Record<string, unknown>[] } }, ack: (response: unknown) => void) => {
                assert.equal(event, 'modifyDocument'); assert.equal(payload.type, 'Actor'); assert.equal(payload.action, 'update');
                const result = payload.operation.updates.map(update => {
                    const { _id, ...patch } = update;
                    this.calls.push(String(_id));
                    const next = applyMigrationPatch(this.native.get(String(_id))!, patch);
                    this.native.set(String(_id), next); return next;
                });
                ack({ type: payload.type, action: payload.action, operation: payload.operation, result });
            },
        } as never;
        this.setOperationGuard(send => {
            if (!serviceAccountAuthority.isQualified()) throw new Error('Service authority unavailable');
            return dispatchCoreMutation(send);
        });
    }
}

export async function run(): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-upgrade-boundaries-'));
    let detach: (() => void) | undefined;
    try {
        const candidate = fixture(path.join(root, 'candidate'));
        fs.writeFileSync(path.join(candidate.root, 'logic.js'), 'export class Adapter {}');
        fs.writeFileSync(path.join(candidate.root, 'ui.js'), 'export default {}');
        const catalog = discoverMigrations(candidate.root, candidate.info)!;
        const native = new Map<string, Record<string, unknown>>(['a', 'b'].map(id => [id, {
            _id: id, name: id, type: 'character', system: { fixed: false }, items: [], effects: [], ownership: { default: 0 },
        }]));
        const calls: string[] = [];
        const transport = new OfflineCoreSocket(native, calls);
        detach = new FoundryEventIngress().attach(transport);
        await userStore.seed(async () => [{ _id: 'service', name: 'service', role: 4 }]);
        serviceAccountAuthority.verify({ userId: 'service', users: userStore.list() }, 'service', transport.userId);
        await actorStore.seed(async () => [...native.values()]);
        await itemStore.seed(async () => []); await sceneStore.seed(async () => []); await settingStore.seed(async () => []);
        moduleWorldContext.configure('http://offline.invalid', world.identity);

        let loaded = 0; let initialized = 0; let prepared = 0;
        const bootstrap = new WorldBootstrapper({
            getBootstrapSnapshot: async () => ({ gameData: { world: { id: 'w1' }, system: { id: 'fixture', version: '1.0.0' },
                release: { generation: 14, build: '367' }, userId: 'service', users: [{ _id: 'service', name: 'service', role: 4 }] } }),
            getSystem: () => ({ id: 'fixture', version: '1.0.0' }), getRegisteredModules: () => [candidate.info],
            getCurrentWorldId: () => 'w1',
            seedPackMetadata: () => {}, seedDocuments: async () => {
                await actorStore.seed(async () => [...native.values()]); await itemStore.seed(async () => []);
                await sceneStore.seed(async () => []); await settingStore.seed(async () => []);
            },
            configureWorldContext: (_snapshot, _module, epoch) => moduleWorldContext.configure('http://offline.invalid', { ...world.identity, runtimeEpoch: epoch }),
            loadAdapter: async () => { loaded += 1; return { systemId: 'fixture', match: () => true,
                normalizeActorData: actor => ({ ...actor, id: actor._id, img: '', derived: {} }), initialize: async () => { initialized += 1; } }; },
            createModuleRuntime: async () => ({ moduleId: 'fixture' } as never),
            checkDataCompatibility: async (_systemId, prepare) => {
                const inventory = await enumerateMigrationTargets(transport, new Set(['Actor']));
                const checked = planWorldMigrations(candidate.root, catalog, moduleWorldContext.snapshot(), inventory, true);
                if (checked.blockers.length) {
                    worldWorkGate.block('migration-compatibility', { phase: 'blocked', message: 'World unavailable — maintenance required' });
                    throw new Error('Source needs maintenance');
                }
                await prepare();
            },
            prepareActors: () => { prepared += 1; return { prepared: native.size, failed: 0 }; }, markLifecycleActive: () => {},
        });
        await assert.rejects(bootstrap.bootstrap(transport), /maintenance/);
        assert.equal(loaded + initialized + prepared, 0, 'actual bootstrap holds adapter loading and preparation behind fresh source checks');
        assert.equal(calls.length, 0, 'bootstrap never authorizes new repairs');
        assert.equal(worldWorkGate.isOpen(), false);

        const modules = path.join(root, 'modules'); fs.mkdirSync(modules);
        const previous = path.join(modules, 'fixture'); fs.mkdirSync(previous); fs.writeFileSync(path.join(previous, 'prior.txt'), 'retained');
        const archive = path.join(root, 'candidate.tgz');
        tar.create({ cwd: candidate.root, gzip: true, file: archive, sync: true }, fs.readdirSync(candidate.root));
        const staged = await prepareModuleArchive({ archivePath: archive, stagingRoot: root, coreVersion: '0.18.1' });
        const journal = new UpgradeJournal(path.join(root, 'journal'));
        let promoted = false; let restarts = 0; let first = true;
        const coordinator = new ModuleUpgradeCoordinator({
            journal, gate: worldWorkGate,
            assertAuthority: () => { if (!serviceAccountAuthority.checkCurrent(userStore.get('service'))) throw new Error('Full GM required'); },
            snapshot: async () => {
                await actorStore.seed(async () => [...native.values()]);
                return { world: moduleWorldContext.snapshot(), targets: await enumerateMigrationTargets(transport, new Set(['Actor'])) };
            },
            promote: async job => {
                job.transactionDirectory = staged.transactionDirectory;
                await promotePreparedModuleArchive(staged, modules, (phase, paths) => {
                    job.fileTransition = phase; job.targetDirectory = paths.targetDirectory; job.previousDirectory = paths.previousDirectory; journal.save(job);
                });
                job.fileTransition = 'registered'; journal.save(job); promoted = true;
            }, restart: () => { restarts += 1; },
            write: async (target, updates, fence) => {
                const envelope = migrationEnvelope(target, updates);
                await withMaintenanceDispatch(fence, () => transport.dispatchDocumentSocket(envelope.type, 'update', envelope.operation));
                if (first) { first = false; throw new Error('lost acknowledgement after ingress'); }
            },
            prepare: async () => {
                worldWorkGate.release('migration-compatibility');
                await bootstrap.bootstrap(transport);
            },
            activate: async () => {}, rollbackFiles: async () => {},
        });
        const archivedCandidate = { ...candidate, root: staged.moduleDirectory, artifactDigest: staged.integrity };
        const preview = await coordinator.preview(archivedCandidate);
        assert.equal(promoted, false); assert.equal(calls.length, 0);
        const job = await coordinator.approve(archivedCandidate, { planId: preview.id, idempotencyKey: 'integration-approved', administrator: 'admin', backupAcknowledged: true });
        assert.equal(restarts, 1); assert.equal(initialized, 0); assert.equal(fs.existsSync(path.join(staged.transactionDirectory, 'previous/prior.txt')), true);
        assert.equal(worldWorkGate.isOpen(), false);
        await assert.rejects(dispatchWorldWork(async () => calls.push('ordinary')), /unavailable/);
        const installed = { ...archivedCandidate, root: path.join(modules, 'fixture') };
        await assert.rejects(coordinator.resume(job.jobId, installed), /uncertain/);
        assert.deepEqual(calls, ['a']);
        assert.equal((actorStore.get('a')?.system as Record<string, unknown>).fixed, true, 'confirmed dispatch follows real ingress into ActorStore');
        await coordinator.resume(job.jobId, installed);
        assert.deepEqual(calls, ['a', 'b'], 'reloaded job/readback do not repeat an acknowledged or ambiguously applied target');
        assert.equal(initialized, 1); assert.equal(prepared, 1); assert.equal(journal.job(job.jobId).phase, 'completed');
        assert.equal(worldWorkGate.isOpen(), true);

        // A real exited process leaves a lease that only the same approved job
        // may take over. No service or network listener is started.
        const restartPreview = await coordinator.preview(installed);
        const restartedJob = await new ModuleUpgradeCoordinator({
            journal, gate: worldWorkGate, snapshot: async () => ({ world: moduleWorldContext.snapshot(), targets: await enumerateMigrationTargets(transport, new Set(['Actor'])) }),
            assertAuthority: () => {}, write: async () => { throw new Error('No writes expected'); }, promote: async () => {}, restart: () => {},
            prepare: async () => {}, activate: async () => {}, rollbackFiles: async () => {},
        }).approve(installed, { planId: restartPreview.id, idempotencyKey: 'restart-fixture', administrator: 'admin', backupAcknowledged: true });
        journal.release(restartedJob);
        const worker = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/upgrade-lease-worker.ts', import.meta.url)), journal.root, restartedJob.jobId], { cwd: process.cwd(), encoding: 'utf8' });
        assert.equal(worker.status, 17, worker.stderr);
        const recovered = journal.job(restartedJob.jobId);
        recovered.leaseToken = journal.acquire(recovered); journal.save(recovered);
        journal.assertLease(recovered); journal.release(recovered);
        recovered.phase = 'cancelled'; journal.save(recovered); worldWorkGate.release('module-upgrade');

        // Inject interruption at every persisted rename boundary, using the
        // production promotion and deployment-only recovery implementation.
        for (const boundary of ['intent', 'previous-retained', 'promoted'] as const) {
            const data = path.join(root, `crash-${boundary}`);
            const archiveRoot = path.join(data, 'dist', 'archives'); fs.mkdirSync(archiveRoot, { recursive: true });
            const managedRoot = path.join(data, 'modules'); fs.mkdirSync(managedRoot);
            const oldRoot = path.join(managedRoot, 'fixture'); fs.mkdirSync(oldRoot); fs.writeFileSync(path.join(oldRoot, 'old.txt'), 'old package');
            const stagedCrash = await prepareModuleArchive({ archivePath: archive, stagingRoot: archiveRoot, coreVersion: '0.18.1' });
            const crashed = { ...journal.job(job.jobId), possibleWrite: false, phase: 'recovery-required' as const, transactionDirectory: stagedCrash.transactionDirectory };
            await assert.rejects(() => promotePreparedModuleArchive(stagedCrash, managedRoot, (phase, locations) => {
                Object.assign(crashed, locations, { fileTransition: phase });
                if (phase === boundary) throw new Error('injected process interruption');
            }));
            rollbackUpgradeFiles(crashed, data);
            assert.equal(fs.readFileSync(path.join(oldRoot, 'old.txt'), 'utf8'), 'old package');
            assert.throws(() => rollbackUpgradeFiles({ ...crashed, possibleWrite: true }, data), /Cannot roll back/);
        }

        for (const generation of [13, 14]) {
            worldStateStore.seed({ world: { id: 'w1' }, system: { id: 'fixture', version: '1.0.0' }, release: { generation } } as any);
            await sceneStore.seed(async () => [{ _id: 'scene', tokens: [
                { _id: 'linked', actorId: 'a', actorLink: true },
                { _id: 'unlinked', actorId: 'a', actorLink: false, delta: { _id: 'delta', effects: [{ _id: 'inherited', _tombstone: true }, { _id: 'own', changes: [] }] } },
            ] }]);
            compendiumStore.setPackMetadata('world.test', { id: 'world.test', type: 'Actor', packageType: 'world', locked: false });
            const inventory = await enumerateMigrationTargets({ dispatchDocumentSocket: async (_type, _action, operation) => {
                assert.equal(operation?.pack, 'world.test'); return { result: [{ _id: 'packed', system: { fixed: false }, items: [], effects: [] }] };
            } }, new Set(['Actor', 'ActorDelta', 'ActiveEffect', 'WorldPack']));
            assert.equal(inventory.filter(row => row.uuid === 'Actor.a').length, 1, 'shared/linked base is not duplicated');
            assert.equal(inventory.some(row => row.uuid.includes('inherited')), false, 'deleted inherited effects stay tombstones');
            const delta = inventory.find(row => row.kind === 'ActorDelta')!;
            assert.equal(delta.baseActorUuid, 'Actor.a');
            assert.deepEqual(migrationEnvelope(delta, { 'system.fixed': true }), { type: 'ActorDelta', operation: { parentUuid: 'Scene.scene.Token.unlinked', updates: [{ _id: 'delta', 'system.fixed': true }], broadcast: true } });
            const effect = inventory.find(row => row.uuid.endsWith('.ActiveEffect.own'))!;
            assert.equal(migrationEnvelope(effect, { changes: [] }).operation.parentUuid, delta.uuid);
            const packed = inventory.find(row => row.pack)!;
            const envelope = migrationEnvelope(packed, { 'system.fixed': true });
            assert.equal(envelope.operation.pack, 'world.test'); assert.equal(envelope.operation.parentUuid, undefined);
            transport.emit('foundry:documentDispatchConfirmed', { response: { type: 'Actor', action: 'update', operation: envelope.operation, result: [{ _id: 'packed', system: { fixed: true } }] } });
            assert.equal(actorStore.get('packed'), null, 'pack acknowledgement cannot enter the world ActorStore');
            compendiumStore.setPackMetadata('world.test', { id: 'world.test', type: 'Actor', packageType: 'world', locked: true });
            assert.throws(() => migrationEnvelope(packed, { 'system.fixed': true }), /locked/);
            const exclusions: string[] = [];
            const advisory = await enumerateMigrationTargets({ dispatchDocumentSocket: async () => { throw new Error('Locked advisory pack must not be read'); } }, new Set(['WorldPack']), [], { requiredKinds: new Set(), exclusions });
            assert.equal(advisory.length, 0); assert.equal(exclusions.length, 1, 'advisory exclusion is explicit, not counted as migrated');
            assert.throws(() => migrationEnvelope({ ...packed, pack: 'fixture.package' }, { 'system.fixed': true }), /locked/);
        }
        await sceneStore.seed(async () => []); compendiumStore.clear();

        // An action admitted before maintenance is fenced even after access reopens.
        let continueAction!: () => void;
        const pending = withWorldWorkScope(async () => { await new Promise<void>(resolve => { continueAction = resolve; });
            return dispatchWorldWork(async () => calls.push('stale')); });
        worldWorkGate.block('test', { phase: 'quiescing', message: 'Module upgrade in progress' }); worldWorkGate.release('test');
        continueAction(); await assert.rejects(pending, /unavailable/); assert.deepEqual(calls, ['a', 'b']);

        // Source restoration is checked despite the completed durable job.
        native.get('a')!.system = { fixed: false };
        bootstrap.reset('offline-fixture-restore');
        await assert.rejects(bootstrap.bootstrap(transport), /maintenance/);
        assert.equal(initialized, 1, 'a completed ledger cannot initialize restored incompatible source');

        // Packaging uses real esbuild and the same catalog validation, without initializing an adapter.
        const packaged = path.join(root, 'compiled'); fs.mkdirSync(packaged);
        await packageMigrations(candidate.root, packaged, candidate.info);
        const summary = migrationSummary(discoverMigrations(packaged, candidate.info));
        const manifest = createModuleReleaseManifest(candidate.info, { url: 'module.tgz', size: 1, integrity: candidate.artifactDigest }, { migrations: summary });
        assert.equal(manifest.schemaVersion, 'sheet-delver-release.v2'); assert.equal(manifest.migrations?.steps, 1);
        // Real host dependency refresh, with Actor ingress racing the module's
        // awaited hook. No adapter reinitialization and no stale source rebuild.
        worldWorkGate.release('migration-compatibility'); worldWorkGate.release('runtime-retired');
        const declaration = { key: 'fixture.variant', scope: 'world' as const, systemVersion: '>=1.0.0 <2.0.0', schema: { type: 'boolean' as const }, affectsPreparation: true, exposure: 'authenticated' as const };
        let finishHook!: () => void; let enteredHook!: () => void; let failHook = false; let contextInitializations = 0;
        let hookEntered = new Promise<void>(resolve => { enteredHook = resolve; });
        const contextBootstrap = new WorldBootstrapper({
            getBootstrapSnapshot: async () => ({ gameData: { world: { id: 'w1' }, system: { id: 'fixture', version: '1.0.0' }, release: { generation: 14, build: '367' }, userId: 'service', users: [{ _id: 'service', name: 'service', role: 4 }] } }),
            getSystem: () => ({ id: 'fixture', version: '1.0.0' }), getCurrentWorldId: () => 'w1',
            getRegisteredModules: () => [{ ...candidate.info, worldSettings: [declaration] }], seedDocuments: async () => {},
            configureWorldContext: (_snapshot, _info, epoch) => moduleWorldContext.configure('http://offline.invalid', { ...world.identity, runtimeEpoch: epoch }, [declaration]),
            checkDataCompatibility: async (_id, prepare) => prepare(), createModuleRuntime: async () => ({ moduleId: 'fixture' } as never),
            loadAdapter: async () => ({ systemId: 'fixture', match: () => true, normalizeActorData: actor => ({ ...actor, id: actor._id, img: '', derived: {} }),
                initialize: async () => { contextInitializations += 1; },
                prepareActorData: (actor, context) => ({ ...actor, id: actor._id, img: '', derived: { variant: context.world?.settings['fixture.variant'], hp: actor.system.hp } }),
                onWorldContextChanged: async () => { enteredHook(); if (failHook) throw new Error('fixture refresh failed'); await new Promise<void>(resolve => { finishHook = resolve; }); },
            }), markLifecycleActive: () => {},
        });
        await settingStore.seed(async () => [{ _id: 'rule', key: 'fixture.variant', value: 'false' }]);
        await contextBootstrap.bootstrap(transport);
        await settingStore.seed(async () => [{ _id: 'rule', key: 'fixture.variant', value: 'true' }]);
        const refreshing = contextBootstrap.refreshWorldContext(); await hookEntered;
        assert.equal(worldWorkGate.hasBlock('context-refresh'), true);
        actorStore.applyModifyDocument('Actor', 'update', [{ _id: 'a', 'system.hp': 8 }]);
        finishHook(); await refreshing;
        assert.deepEqual(preparedActorStore.getRequired('a').derived.variant, { status: 'world', value: true });
        assert.equal(preparedActorStore.getRequired('a').derived.hp, 8);
        assert.equal(contextInitializations, 1);
        failHook = true; hookEntered = new Promise<void>(resolve => { enteredHook = resolve; });
        await settingStore.seed(async () => [{ _id: 'rule', key: 'fixture.variant', value: 'false' }]);
        await assert.rejects(contextBootstrap.refreshWorldContext(), /fixture refresh failed/);
        assert.equal(worldWorkGate.hasBlock('context-refresh'), true, 'failed refresh cannot reopen stale prepared data');
        contextBootstrap.reset('fixture-cleanup');
        console.log('module-upgrade-boundaries: actual bootstrap, archive promotion, Core dispatch/ingress, durable outcomes, preparation and restore gates passed (offline wire/restart)');
    } finally {
        detach?.();
        for (const key of ['service-identity', 'migration-compatibility', 'module-upgrade', 'context-refresh', 'runtime-retired', 'test']) worldWorkGate.release(key);
        actorStore.clear(); itemStore.clear(); sceneStore.clear(); settingStore.clear(); userStore.clear(); compendiumStore.clear(); moduleWorldContext.clear();
        worldStateStore.clear();
        fs.rmSync(root, { recursive: true, force: true });
    }
}
if (import.meta.url === `file://${process.argv[1]}`) run().catch(error => { console.error(error); process.exitCode = 1; });
