import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingStore } from '@server/core/documents/primary/settings/SettingStore';
import { ModuleWorldContextService } from '@server/services/world/ModuleWorldContextService';
import { ServiceAccountAuthority } from '@server/core/world/ServiceAccountAuthority';
import { WorldWorkGate, worldWorkGate } from '@server/core/world/WorldWorkGate';
import { discoverMigrations, migrationDigest } from '@modules/registry/migrations/catalog';
import { ModuleUpgradeCoordinator, type UpgradeCoordinatorDeps, type UpgradeCandidate } from '@server/services/world/migrations/ModuleUpgradeCoordinator';
import { UpgradeJournal } from '@server/services/world/migrations/UpgradeJournal';
import { planWorldMigrations, applyMigrationPatch, validateMigrationPatch, hookInput } from '@server/services/world/migrations/planner';
import { runMigrationHook } from '@server/services/world/migrations/hooks';
import { enumerateMigrationTargets, expandMigrationTargets, type MigrationSourceView } from '@server/services/world/migrations/targets';
import type { ModuleWorldSnapshot, WorldSettingDeclaration } from '@shared/sdk/world';
import type { MigrationTarget } from '@shared/sdk/migrations';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { compendiumStore } from '@server/core/compendium/CompendiumStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { canReadNativePack } from '@server/core/documents/primary/base/nativePackPermissions';
import { createActorService } from '@server/services/actors/ActorService';
import { createDocumentStore, createModuleRequestRuntime } from '@server/shared/utils/moduleDocumentServices';

export function fixture(root: string): UpgradeCandidate {
    fs.mkdirSync(path.join(root, 'migrations/1.0.0'), { recursive: true });
    const info = { id: 'fixture', title: 'Offline fixture', version: '1.0.0', manifest: { logic: 'logic.js', ui: 'ui.js' },
        compatibility: { apiContracts: { 'module-api': '>=1.5.0 <2.0.0' } } };
    fs.writeFileSync(path.join(root, 'info.json'), JSON.stringify(info));
    fs.writeFileSync(path.join(root, 'migration.json'), JSON.stringify({ schemaVersion: 'sheet-delver-migrations.v1', systemVersions: { '1.0.0': 'migrations/1.0.0' } }));
    fs.writeFileSync(path.join(root, 'migrations/1.0.0/definition.json'), JSON.stringify({ schemaVersion: 'sheet-delver-migration-definition.v1',
        dataReadVersion: '>=1.0.0 <2.0.0', steps: [{ id: 'fix-key', revision: 1, description: 'Fix fixture value', dependencies: [], systemVersion: '>=1.0.0 <2.0.0',
            foundryGenerations: [13, 14], required: true, targets: ['Actor'], paths: ['system.fixed'], hooks: { check: 'check.cjs', plan: 'plan.cjs', verify: 'verify.cjs' } }] }));
    fs.writeFileSync(path.join(root, 'migrations/1.0.0/check.cjs'), "module.exports=({target})=>({status:target.source.system.fixed===true?'current':'migration-needed'})");
    fs.writeFileSync(path.join(root, 'migrations/1.0.0/plan.cjs'), "module.exports=()=>({status:'patch',updates:{'system.fixed':true}})");
    fs.writeFileSync(path.join(root, 'migrations/1.0.0/verify.cjs'), "module.exports=({target})=>({valid:target.source.system.fixed===true})");
    return { moduleId: info.id, version: info.version, info, root, artifactDigest: migrationDigest('archive fixture bytes') };
}
export const world: ModuleWorldSnapshot = { identity: { instanceId: 'opaque-local', worldId: 'w1', systemId: 'fixture', systemVersion: '1.0.0',
    foundryGeneration: 14, foundryBuild: '367', runtimeEpoch: 1, contextRevision: 1 }, settings: {} };

export async function run(): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-core-migrations-'));
    try {
        const settings = new SettingStore();
        const context = new ModuleWorldContextService(settings);
        const declarations: WorldSettingDeclaration[] = ['false', 'zero', 'null', 'default'].map(key => ({
            key: `fixture.${key}`, scope: 'world', systemVersion: '>=1.0.0 <2.0.0', schema: { type: key === 'zero' ? 'number' : key === 'null' ? 'null' : 'boolean' },
            exposure: key === 'zero' ? 'server' : 'authenticated', affectsPreparation: true,
            default: { value: key === 'zero' ? 0 : key === 'null' ? null : false, source: 'versioned native fixture', systemVersion: '=1.0.0' },
        }));
        context.configure('http://offline.invalid', world.identity, declarations);
        assert.deepEqual(context.handle().settings.get('fixture.false'), { status: 'unavailable', reason: 'not-ready' });
        await settings.seed(async () => [{ _id: 'f', key: 'fixture.false', value: 'false' }, { _id: 'z', key: 'fixture.zero', value: '0' },
            { _id: 'n', key: 'fixture.null', value: 'null' }, { _id: 'u', key: 'fixture.default', user: 'player', value: 'true' }]);
        const first = context.snapshot();
        context.refresh();
        assert.deepEqual(context.handle().settings.get('fixture.false'), { status: 'world', value: false });
        assert.deepEqual(context.handle().settings.get('fixture.zero'), { status: 'world', value: 0 });
        assert.deepEqual(context.handle().settings.get('fixture.null'), { status: 'world', value: null });
        assert.deepEqual(context.handle().settings.get('fixture.default'), { status: 'registered-default', value: false });
        assert.equal(context.project(1).settings['fixture.zero'], undefined);
        assert.equal(first.settings['fixture.false'].status, 'unavailable', 'old snapshots do not mutate');
        assert.throws(() => context.handle().assertRevision(first.identity.contextRevision), /changed/);
        const retired = context.handle(); context.clear(); assert.throws(() => retired.snapshot(), /retired/);

        const authority = new ServiceAccountAuthority();
        for (const role of [0, 1, 2, 3, undefined]) assert.throws(() => authority.verify({ userId: 's', users: [{ _id: 's', name: 'service', role }] }, 'service', 's'), /gm-required/);
        authority.verify({ userId: 's', users: [{ _id: 's', name: 'service', role: 4 }] }, 'service', 's');
        assert.equal(authority.isQualified(), true);
        assert.throws(() => authority.verify({ userId: 'other', users: [{ _id: 's', name: 'service', role: 4 }] }, 'service', 's'));
        authority.verify({ userId: 's', users: [{ _id: 's', name: 'service', role: 4 }] }, 'service', 's');
        assert.equal(authority.checkCurrent({ _id: 's', name: 'service', role: 3 }), false);
        worldWorkGate.release('service-identity');

        const gate = new WorldWorkGate();
        const captured = gate.capture();
        let release!: () => void;
        const sent = gate.dispatch(() => new Promise<void>(resolve => { release = resolve; }));
        gate.block('job', { phase: 'quiescing', message: 'Module upgrade in progress' });
        await assert.rejects(gate.dispatch(async () => undefined), /unavailable/);
        let drained = false;
        const draining = gate.drain().then(() => { drained = true; });
        await Promise.resolve(); assert.equal(drained, false); release(); await sent; await draining;
        gate.release('job'); assert.throws(() => gate.assertOpen(captured), /unavailable/, 'retired callbacks cannot replay after reopening');

        const candidate = fixture(path.join(root, 'candidate'));
        const catalog = discoverMigrations(candidate.root, candidate.info)!;
        const definitionPath = path.join(candidate.root, 'migrations/1.0.0/definition.json');
        const originalDefinition = fs.readFileSync(definitionPath, 'utf8');
        for (const dependency of ['missing-step', 'fix-key']) {
            const invalid = JSON.parse(originalDefinition); invalid.steps[0].dependencies = [dependency];
            fs.writeFileSync(definitionPath, JSON.stringify(invalid));
            assert.throws(() => discoverMigrations(candidate.root, candidate.info), /dependency|cycle/);
        }
        const traversal = JSON.parse(originalDefinition); traversal.steps[0].hooks.check = '../../escape.cjs';
        fs.writeFileSync(definitionPath, JSON.stringify(traversal));
        assert.throws(() => discoverMigrations(candidate.root, candidate.info), /Unconfined/);
        fs.writeFileSync(definitionPath, originalDefinition);
        assert.throws(() => discoverMigrations(candidate.root, { ...candidate.info, compatibility: { apiContracts: { 'module-api': '>=1.4.0' } } }), /exclude/);
        assert.throws(() => discoverMigrations(candidate.root, { ...candidate.info, compatibility: { apiContracts: { 'module-api': '>=1.3.0 <1.4.0' } } }), /exclude/, 'excluding only 1.4 does not exclude earlier hosts');
        const parameters = JSON.parse(originalDefinition); parameters.steps[0].parameters = { limit: 'wrong' }; parameters.steps[0].parameterSchema = { limit: { type: 'number', minimum: 1 } };
        fs.writeFileSync(definitionPath, JSON.stringify(parameters));
        assert.throws(() => discoverMigrations(candidate.root, candidate.info), /parameters/);
        fs.writeFileSync(definitionPath, originalDefinition);
        let targets: MigrationTarget[] = [{ uuid: 'Actor.a', kind: 'Actor', source: { _id: 'a', system: { fixed: false }, flags: { untouched: true } } }];
        const planned = planWorldMigrations(candidate.root, catalog, world, targets);
        assert.equal(planned.blockers.length, 0); assert.equal(planned.operations.length, 1);
        assert.equal(planWorldMigrations(candidate.root, catalog, world, targets, true).blockers.length, 1, 'completed ledgers cannot exempt restored source');
        const journal = new UpgradeJournal(path.join(root, 'journal'));
        let writes = 0; let initialized = 0; let restarted = 0; let promoted = 0;
        let uncertain = false;
        const deps: UpgradeCoordinatorDeps = { journal, gate, assertAuthority: () => {}, snapshot: async () => ({ world, targets: structuredClone(targets) }),
            write: async (target, updates, fence) => { fence(); writes += 1; target.source = applyMigrationPatch(target.source, updates); targets = [target];
                if (uncertain) { uncertain = false; throw new Error('timeout after applied'); } },
            promote: async () => { promoted += 1; }, restart: () => { restarted += 1; },
            prepare: async () => { initialized += 1; }, activate: async () => {}, rollbackFiles: async () => {} };
        const coordinator = new ModuleUpgradeCoordinator(deps);
        const preview = await coordinator.preview(candidate);
        assert.equal(initialized + writes + promoted, 0, 'preview never initializes, promotes or writes');
        const approval = { planId: preview.id, idempotencyKey: 'request-0001', backupAcknowledged: true, administrator: 'admin' };
        await assert.rejects(coordinator.approve(candidate, { ...approval, backupAcknowledged: false }), /acknowledgement/);
        const job = await coordinator.approve(candidate, approval);
        assert.equal(restarted, 1); assert.equal(gate.isOpen(), false);
        assert.equal((await coordinator.approve(candidate, approval)).jobId, job.jobId);
        uncertain = true;
        await assert.rejects(coordinator.resume(job.jobId, candidate), /uncertain/);
        assert.equal(journal.job(job.jobId).possibleWrite, true);
        assert.equal(journal.job(job.jobId).outcomes['0:fix-key:Actor.a'].state, 'uncertain');
        await coordinator.resume(job.jobId, candidate);
        assert.equal(writes, 1, 'readback reconciles applied timeout without duplicate dispatch');
        assert.equal(initialized, 1); assert.equal(journal.job(job.jobId).phase, 'completed'); assert.equal(gate.isOpen(), true);
        targets[0].source.system = { fixed: false };
        assert.equal(planWorldMigrations(candidate.root, catalog, world, targets, true).blockers.length, 1, 'external restore detected despite completed journal');

        for (const count of [0, 1, 100, 101, 201]) {
            const inventory = Array.from({ length: count }, (_, i): MigrationTarget => ({ uuid: `Actor.row${i}`, kind: 'Actor', source: { _id: `row${i}`, system: { fixed: false } } }));
            const all = planWorldMigrations(candidate.root, catalog, world, inventory);
            assert.equal(all.checked, count); assert.equal(all.operations.length, count, 'no first-page or 100-target truncation');
        }
        assert.throws(() => validateMigrationPatch(catalog.steps[0], { 'ownership.default': 3 }), /declared paths/);
        assert.throws(() => validateMigrationPatch(catalog.steps[0], JSON.parse('{"system.fixed":{"__proto__":{"polluted":true}}}')), /Unsafe/);
        assert.equal(hookInput(world, targets[0], targets, catalog.steps[0]).references.length, 0, 'undeclared reference dependencies are not exposed');

        // Two tabs cannot create independent pending jobs or steal a live lease.
        const competingJournal = new UpgradeJournal(path.join(root, 'competing'));
        const competingGate = new WorldWorkGate();
        const competing = new ModuleUpgradeCoordinator({ ...deps, journal: competingJournal, gate: competingGate });
        const p1 = await competing.preview(candidate); const p2 = await competing.preview(candidate);
        const firstJob = await competing.approve(candidate, { ...approval, planId: p1.id, idempotencyKey: 'first-tab' });
        await assert.rejects(competing.approve(candidate, { ...approval, planId: p2.id, idempotencyKey: 'second-tab' }), /lease|runner/);
        assert.equal(competingJournal.jobs().length, 1, 'losing tab leaves no orphan job');
        await competing.cancel(firstJob.jobId); assert.equal(competingGate.isOpen(), true);

        // Stale preflight cannot promote, and cancellation remains pre-write only.
        const stalePreview = await competing.preview(candidate);
        targets[0].source.name = 'native edit';
        await assert.rejects(competing.approve(candidate, { ...approval, planId: stalePreview.id, idempotencyKey: 'stale-tab' }), /changed/);
        const staleJob = competingJournal.jobs().find(row => row.phase === 'recovery-required')!;
        assert.equal(staleJob.possibleWrite, false);
        await competing.cancel(staleJob.jobId);

        // A partially applied plan which then regresses cannot silently replay.
        const partialJournal = new UpgradeJournal(path.join(root, 'partial'));
        const partialGate = new WorldWorkGate();
        targets = ['a', 'b'].map(id => ({ uuid: `Actor.${id}`, kind: 'Actor', source: { _id: id, system: { fixed: false } } }));
        let partialWrites = 0; let interrupt = true;
        const partial = new ModuleUpgradeCoordinator({ ...deps, journal: partialJournal, gate: partialGate,
            write: async (target, updates, fence) => { fence(); partialWrites += 1;
                if (target.uuid === 'Actor.b' && interrupt) { interrupt = false; throw new Error('unknown acknowledgement'); }
                targets.find(row => row.uuid === target.uuid)!.source = applyMigrationPatch(target.source, updates);
            } });
        const partialPreview = await partial.preview(candidate);
        const partialJob = await partial.approve(candidate, { ...approval, planId: partialPreview.id, idempotencyKey: 'partial-job' });
        await assert.rejects(partial.resume(partialJob.jobId, candidate), /uncertain/);
        targets[0].source.system = { fixed: false }; // external restore after a confirmed target
        await assert.rejects(partial.resume(partialJob.jobId, candidate), /regressed/);
        assert.equal(partialWrites, 2, 'regressed source never replayed under previous approval');
        const revised = await partial.reviewRecovery(partialJob.jobId, candidate);
        await assert.rejects(partial.reapprove(partialJob.jobId, candidate, revised.id, 'admin', false), /approval/);
        await partial.reapprove(partialJob.jobId, candidate, revised.id, 'admin', true);
        await partial.resume(partialJob.jobId, candidate);
        assert.equal(partialJournal.job(partialJob.jobId).phase, 'completed');
        assert.equal(partialJournal.job(partialJob.jobId).priorApprovals?.length, 1, 'original write evidence survives renewed review');
        assert.equal(partialGate.isOpen(), true);

        // A late native edit during candidate preparation cannot activate readiness.
        const prepareJournal = new UpgradeJournal(path.join(root, 'prepare-conflict'));
        const prepareGate = new WorldWorkGate();
        const prepareConflict = new ModuleUpgradeCoordinator({ ...deps, journal: prepareJournal, gate: prepareGate,
            prepare: async () => { targets[0].source.name = 'changed during prepare'; } });
        const preparePreview = await prepareConflict.preview(candidate);
        const prepareJob = await prepareConflict.approve(candidate, { ...approval, planId: preparePreview.id, idempotencyKey: 'prepare-job' });
        await assert.rejects(prepareConflict.resume(prepareJob.jobId, candidate), /Source changed during preparation/);
        assert.equal(prepareGate.isOpen(), false);
        assert.equal(prepareJournal.job(prepareJob.jobId).phase, 'recovery-required');

        fs.writeFileSync(path.join(root, 'partial/jobs', `${partialJob.jobId}.json`), '{}');
        assert.throws(() => partialJournal.job(partialJob.jobId), /schema/);

        // The actual Actor detail service preserves source identity even when
        // same-name entries live in distinct packs and a privileged cache is warm.
        await userStore.seed(async () => [0, 1, 2, 3, 4].map(role => ({ _id: `role${role}`, name: `Role ${role}`, role })));
        await settingStore.seed(async () => []);
        const pack1 = 'fixture.one'; const pack2 = 'fixture.two';
        const uuid1 = `Compendium.${pack1}.Item.same`; const uuid2 = `Compendium.${pack2}.Item.same`;
        compendiumStore.setPackIndex(pack1, { id: pack1, type: 'Item', ownership: { PLAYER: 'OBSERVER' } }, [{ _id: 'same', name: 'Same Name' }]);
        compendiumStore.setPackIndex(pack2, { id: pack2, type: 'Item', ownership: { GAMEMASTER: 'OWNER' } }, [{ _id: 'same', name: 'Same Name' }]);
        for (const generation of [13, 14]) {
            worldStateStore.seed({ world: { id: 'w1' }, system: { id: 'fixture', version: '1.0.0' }, release: { generation } } as any);
            assert.equal(canReadNativePack('role0', pack1), false);
            assert.equal(canReadNativePack('role4', pack2), true);
            assert.equal(canReadNativePack('role1', pack1), generation === 14);
            assert.equal(canReadNativePack('role3', pack2), generation === 13, 'native generation-specific Assistant pack rule retained');
        }
        const sourceActor = { _id: 'canonical', id: 'canonical', name: 'Actor', type: 'character', system: { first: uuid1, second: uuid2 }, items: [], effects: [], derived: {}, img: '' };
        const detailService = createActorService({ normalizeActors: async () => [], getPreparedActor: () => structuredClone(sourceActor), config: {} as any });
        let readable = true;
        const client = { userId: 'role1', getSystem: async () => ({ id: '' }), getActor: async () => readable ? structuredClone(sourceActor) : null, resolveUrl: (s: string) => s, url: 'http://offline.invalid' } as any;
        const detail = await detailService.getActorById(client, 'canonical');
        assert.ok('system' in detail);
        assert.deepEqual(detail.system, sourceActor.system, 'canonical UUIDs never replaced with labels');
        assert.deepEqual(detail.referenceLabels, { [uuid1]: 'Same Name' }, 'private cached pack cannot supply presentation labels');
        assert.deepEqual(sourceActor.system, { first: uuid1, second: uuid2 }, 'source/editor round trip remains lossless');
        readable = false;
        assert.equal((await detailService.getActorById(client, 'canonical')).status, 404, 'detail cannot expand LIMITED/no-detail caller access');
        await settingStore.seed(async () => [{ _id: 'permissions', key: 'core.compendiumConfiguration', value: JSON.stringify({ [pack1]: { ownership: { GAMEMASTER: 'OWNER' } } }) }]);
        readable = true;
        const revokedDetail = await detailService.getActorById(client, 'canonical');
        assert.ok('referenceLabels' in revokedDetail);
        assert.deepEqual(revokedDetail.referenceLabels, {}, 'revoked pack rights win over a warm index');
        await settingStore.seed(async () => []);
        const scoped = createDocumentStore({ userId: 'role1', fetchByUuid: async () => {
            userStore.applyModifyDocument('User', 'update', [{ _id: 'role1', role: 0 }]);
            return { _id: 'same', uuid: uuid1, secret: 'must not escape' };
        } } as any, async () => {});
        await assert.rejects(scoped.fetchByUuid(uuid1), /access changed/, 'UUID read reauthorizes after controlled await');
        userStore.applyModifyDocument('User', 'update', [{ _id: 'role1', role: 1 }]);
        await assert.rejects(scoped.fetchByUuid(uuid1, { access: { userId: 'role4', role: 4, isGM: true, moduleId: 'fixture' } }), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'permission_denied'), 'player cannot borrow a full-GM read subject');
        for (const type of ['Item', 'Actor', 'Spell', 'RollTable']) {
            const request = createModuleRequestRuntime({ moduleId: 'fixture', compendium: { findAll: async () => {
                await settingStore.seed(async () => [{ _id: 'permissions', key: 'core.compendiumConfiguration', value: JSON.stringify({ [pack1]: { ownership: { GAMEMASTER: 'OWNER' } } }) }]);
                return [{ _id: 'same', uuid: uuid1, secret: 'must not escape' }];
            } } } as any, { userId: 'role1' } as any, async () => {});
            await settingStore.seed(async () => []);
            assert.deepEqual(await request.compendium.findAll(type), [], `${type} query/card/index consumers cannot use a warmed privileged cache after pack revocation`);
        }

        const children = expandMigrationTargets('Scene.s.Token.t.ActorDelta.d', 'ActorDelta', { _id: 'd', items: [
            { _id: 'deleted', _tombstone: true }, { _id: 'own', effects: [{ _id: 'e', changes: [] }] }] });
        assert.equal(children.length, 3); assert.equal(children.some(row => row.uuid.includes('deleted')), false);
        assert.equal(children[2].uuid, 'Scene.s.Token.t.ActorDelta.d.Item.own.ActiveEffect.e');
        const nativeDeltaView: MigrationSourceView = {
            actors: [{ _id: 'base', items: [{ _id: 'base-item' }] }], items: [], packs: [], configuration: {},
            subject: { userId: 'service', role: 4 }, generation: 14,
            scenes: [{ _id: 'scene', tokens: [
                { _id: 'lazy', actorId: 'base', actorLink: false, delta: null },
                { _id: 'decorative', actorId: null, actorLink: false, delta: null },
                { _id: 'owned', actorId: 'base', actorLink: false, delta: { _id: 'delta', items: [{ _id: 'own' }] } },
            ] }],
        };
        const noTransport = { dispatchDocumentSocket: async () => { throw new Error('Unexpected native read'); } };
        const nativeTargets = await enumerateMigrationTargets(noTransport, new Set(['Actor', 'Item', 'ActorDelta']), [], { view: nativeDeltaView });
        assert.deepEqual(nativeTargets.map(target => target.uuid), ['Actor.base', 'Actor.base.Item.base-item',
            'Scene.scene.Token.owned.ActorDelta.delta', 'Scene.scene.Token.owned.ActorDelta.delta.Item.own'],
        'native lazy null deltas have no owned overrides; enumerate base once without materializing a synthetic delta');
        const missingBase = structuredClone(nativeDeltaView); missingBase.actors = [];
        await assert.rejects(enumerateMigrationTargets(noTransport, new Set(['ActorDelta']), [], { view: missingBase }), /delta\/base Actor is unavailable/);
        const malformedDelta = structuredClone(nativeDeltaView);
        (malformedDelta.scenes[0].tokens as Record<string, unknown>[])[0].delta = 'invalid';
        await assert.rejects(enumerateMigrationTargets(noTransport, new Set(['ActorDelta']), [], { view: malformedDelta }), /delta\/base Actor is unavailable/);
        fs.writeFileSync(path.join(candidate.root, 'migrations/1.0.0/check.cjs'), 'module.exports=()=>({status:globalThis.Date.now()})');
        const impure = discoverMigrations(candidate.root, candidate.info)!;
        assert.throws(() => runMigrationHook(candidate.root, impure.steps[0], 'check', { world, target: targets[0], references: [], parameters: {} }), /undefined|now/, 'global Date cannot bypass the pure hook clock restriction');
        fs.writeFileSync(path.join(candidate.root, 'migrations/1.0.0/check.cjs'), 'module.exports=()=>{while(true){}}');
        assert.throws(() => runMigrationHook(candidate.root, catalog.steps[0], 'check', { world, target: targets[0], references: [], parameters: {} }), /digest/);
        const changed = discoverMigrations(candidate.root, candidate.info)!;
        assert.throws(() => runMigrationHook(candidate.root, changed.steps[0], 'check', { world, target: targets[0], references: [], parameters: {} }), /timed out/);
        assert.equal(initialized, 2, 'only the two explicitly approved successful jobs prepared an adapter');
        console.log('module-world-migrations: settings, authority, fencing, full enumeration, competing approvals, stale plans, partial/uncertain recovery, renewed restore approval, preparation conflicts and delta checks passed');
    } finally { worldWorkGate.release('service-identity'); userStore.clear(); settingStore.clear(); compendiumStore.clear(); worldStateStore.clear(); fs.rmSync(root, { recursive: true, force: true }); }
}
if (import.meta.url === `file://${process.argv[1]}`) run().catch(error => { console.error(error); process.exitCode = 1; });
