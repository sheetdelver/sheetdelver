import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture, world } from '../unit/world/module-world-migrations.test';
import { discoverMigrations } from '@modules/registry/migrations/catalog';
import { expandMigrationTargets } from '@server/services/world/migrations/targets';
import { hookInput, planWorldMigrations, migrationInputHashes } from '@server/services/world/migrations/planner';
import { canReadNativePack } from '@server/core/documents/primary/base/nativePackPermissions';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { compendiumStore } from '@server/core/compendium/CompendiumStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { createMaintenanceCandidate, maintenanceInventory } from '../fixtures/maintenanceInventory';
import { computeWorldMigrations } from '@server/services/world/migrations/compute';
import { UpgradeJournal, type UpgradeJob } from '@server/services/world/migrations/UpgradeJournal';
import { ModuleUpgradeCoordinator } from '@server/services/world/migrations/ModuleUpgradeCoordinator';
import { WorldWorkGate } from '@server/core/world/WorldWorkGate';
import { applyMigrationPatch } from '@server/services/world/migrations/planner';
import { initDataDir } from '@server/core/paths';
import { acquireCoreRuntimeLease, readMaintenanceMode, saveMaintenanceMode, maintenanceOnly } from '@server/core/world/MaintenanceMode';
import { MaintenanceController } from '@server/services/world/migrations/MaintenanceController';

const cases: Record<string, (root: string) => Promise<void>> = {};
async function batchCase(root: string, partial = false) {
    const candidate = fixture(path.join(root, 'candidate'));
    let rows = Array.from({ length: 70 }, (_, i) => ({ uuid: `Actor.a${i}`, kind: 'Actor' as const, source: { _id: `a${i}`, system: { fixed: false } } }));
    const journal = new UpgradeJournal(path.join(root, 'journal')); let sends = 0; let lost = false; const written = new Set<string>();
    const updateRow = (target: { uuid: string }, updates: Record<string, unknown>) => {
        assert.ok(!written.has(target.uuid), `no replay of ${target.uuid}`); written.add(target.uuid);
        rows = rows.map(row => row.uuid === target.uuid ? { ...row, source: applyMigrationPatch(row.source, updates) as typeof row.source } : row);
    };
    const coordinator = new ModuleUpgradeCoordinator({ journal, gate: new WorldWorkGate(), assertAuthority() {},
        snapshot: async () => ({ world, targets: structuredClone(rows) }),
        write: async (target, updates) => { sends++; updateRow(target, updates); },
        writeBatch: async (entries, fence) => { fence(); sends++;
            const stored = journal.jobs()[0]; assert.ok(entries.every(({ target }) => Object.keys(stored.outcomes).some(key => key.endsWith(`:${target.uuid}`))), 'all batch intents precede dispatch');
            for (const { target, updates } of entries) { updateRow(target, updates);
                if (partial && !lost && written.size === 3) { lost = true; throw new Error('partial native batch, lost receipt'); } }
        }, promote: async () => {}, restart() {}, prepare: async () => {}, activate: async () => {}, rollbackFiles: async () => {},
    });
    const preview = await coordinator.preview(candidate);
    const job = await coordinator.approve(candidate, { planId: preview.id, idempotencyKey: 'bounded-batch-approval', backupAcknowledged: true, administrator: 'test' });
    job.expiresAt = 0; journal.save(job); // executing approval does not expire with its preview
    if (partial) { await assert.rejects(coordinator.resume(job.jobId, candidate), /uncertain/); assert.equal(written.size, 3); }
    const result = await coordinator.resume(job.jobId, candidate);
    assert.equal(result.phase, 'completed'); assert.equal(Object.keys(result.outcomes).length, 70);
    assert.equal(written.size, 70);
    if (!partial) assert.ok(sends <= 2, `expected bounded native batches, got ${sends} separate sends`);
    const sendsAtCompletion = sends; await coordinator.resume(job.jobId, candidate); assert.equal(sends, sendsAtCompletion);
}
cases['bounded-batches'] = root => batchCase(root);
cases['partial-batch'] = root => batchCase(root, true);
cases['persistent-exclusive-mode'] = async root => {
    initDataDir(root);
    const release = acquireCoreRuntimeLease(); assert.throws(() => acquireCoreRuntimeLease(), /live Core/); release();
    saveMaintenanceMode({ schemaVersion: 1, id: 'test', moduleId: 'fixture', stage: 'review', updatedAt: Date.now() });
    assert.equal(maintenanceOnly(), true);
    const controller = new MaintenanceController({} as never, () => { throw new Error('must not activate'); });
    await assert.rejects(controller.plan(), /Normal native sends did not settle/);
    assert.equal(readMaintenanceMode()?.stage, 'recovery-required');
    const file = path.join(root, 'config/module-upgrades/maintenance.json');
    fs.writeFileSync(file, '{broken');
    assert.equal(readMaintenanceMode()?.diagnosticOnly, true); assert.equal(maintenanceOnly(), true);
    assert.throws(() => saveMaintenanceMode(readMaintenanceMode()!), /cannot overwrite/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
};
cases.relations = async root => {
    const candidate = fixture(root);
    candidate.info.compatibility = { apiContracts: { 'module-api': '>=1.6.0 <2.0.0' } };
    const file = path.join(root, 'migrations/1.0.0/definition.json');
    const def = JSON.parse(fs.readFileSync(file, 'utf8'));
    def.steps[0].targets = ['WorldPack'];
    def.steps[0].reads = { relations: [{ relation: 'ancestors', forKinds: ['ActiveEffect'], fields: ['type'], required: true }] };
    fs.writeFileSync(file, JSON.stringify(def));
    const catalog = discoverMigrations(root, candidate.info)!;
    const targets = expandMigrationTargets('Compendium.world.arbitrary.Actor.a', 'Actor', { _id: 'a', type: 'Player', system: { private: 'not selected' },
        items: [{ _id: 'i', type: 'Weapon', effects: [{ _id: 'e', changes: [] }] }] }, 'world.arbitrary');
    const effect = targets.find(row => row.kind === 'ActiveEffect')!;
    const input = hookInput(world, effect, targets, catalog.steps[0]) as unknown as { relations: { ancestors: typeof targets } };
    assert.deepEqual(input.relations.ancestors.map(row => [row.uuid, row.source]), [
        ['Compendium.world.arbitrary.Actor.a.Item.i', { type: 'Weapon' }], ['Compendium.world.arbitrary.Actor.a', { type: 'Player' }],
    ]);
    const before = migrationInputHashes(world, effect, targets, catalog.steps[0]);
    targets[0].source.type = 'Changed';
    assert.notDeepEqual(migrationInputHashes(world, effect, targets, catalog.steps[0]), before, 'declared ancestors remain in exact dependency evidence');
    assert.throws(() => hookInput(world, { ...effect, uuid: 'ActiveEffect.orphan' }, [], catalog.steps[0]), /Required ancestors/);
    def.steps[0].reads.relations = [{ relation: 'baseActor', forKinds: ['ActorDelta'], fields: ['type', 'system.zero', 'system.empty'], required: true }];
    fs.writeFileSync(file, JSON.stringify(def));
    const deltaCatalog = discoverMigrations(root, candidate.info)!;
    const base = { uuid: 'Actor.base', kind: 'Actor' as const, source: { _id: 'base', type: 'Player', system: { zero: 0, empty: null, secret: 'not selected' } } };
    const delta = { uuid: 'Scene.s.Token.t.ActorDelta.d', kind: 'ActorDelta' as const, baseActorUuid: base.uuid, source: { _id: 'd', system: { hp: null }, unknown: false } };
    const deltaInput = hookInput(world, delta, [base, delta], deltaCatalog.steps[0]);
    assert.deepEqual(deltaInput.relations?.baseActor?.source, { type: 'Player', system: { zero: 0, empty: null } });
    assert.deepEqual(deltaInput.target.source, delta.source, 'base defaults never materialize into persisted partial overrides');
    assert.throws(() => discoverMigrations(root, { ...candidate.info, compatibility: { apiContracts: { 'module-api': '>=1.5.0 <2.0.0' } } }), /module-api 1\.6/);
    def.steps[0].reads.relations[0].fields = ['effects']; fs.writeFileSync(file, JSON.stringify(def));
    assert.throws(() => discoverMigrations(root, candidate.info), /relation/i, 'whole child collections cannot masquerade as bounded relation fields');
};
cases.diagnostics = async root => {
    const candidate = fixture(root);
    fs.writeFileSync(path.join(root, 'migrations/1.0.0/check.cjs'), "module.exports=()=>({status:'unresolved',reason:'Parent Actor type is missing; check Actor.a'})");
    const catalog = discoverMigrations(root, candidate.info)!;
    const result = planWorldMigrations(root, catalog, world, expandMigrationTargets('Actor.a', 'Actor', { _id: 'a' }));
    assert.match(result.blockers.join(' '), /Parent Actor type is missing; check Actor.a/);
    assert.match(result.blockers.join(' '), /check/);
};
cases['native13-pack'] = async () => {
    await actorStore.seed(async () => []);
    await userStore.seed(async () => [{ _id: 'player', role: 1 }]);
    await settingStore.seed(async () => []);
    compendiumStore.setPackMetadata('world.readable', { id: 'world.readable', type: 'Item', ownership: { PLAYER: 'OBSERVER', ASSISTANT: 'OWNER' } });
    worldStateStore.seed({ world: { id: 'w1' }, system: { id: 'fixture', version: '1.0.0' }, release: { generation: 13, build: '351' } });
    assert.equal(canReadNativePack('player', 'world.readable'), true, 'native v13 role1 receives OBSERVER');
    await settingStore.seed(async () => [{ _id: 'config', key: 'core.compendiumConfiguration', value: JSON.stringify({ 'world.readable': { ownership: { PLAYER: 'NONE' } } }) }]);
    assert.equal(canReadNativePack('player', 'world.readable'), false, 'warm metadata is not authority after revocation');
};
cases.capacity = async root => {
    const candidate = createMaintenanceCandidate(root);
    const catalog = discoverMigrations(root, candidate.info)!;
    const counts = [];
    for (const [actors, items] of [[30, 30], [100, 60]]) {
        const inventory = maintenanceInventory(actors, items, true);
        const targets = [...inventory.actors.flatMap(row => expandMigrationTargets(`Actor.${row._id}`, 'Actor', row)),
            ...inventory.items.flatMap(row => expandMigrationTargets(`Item.${row._id}`, 'Item', row))];
        let ticks = 0; let last = 0;
        const timer = setInterval(() => ticks++, 10); const start = Date.now();
        const plan = await computeWorldMigrations(root, catalog, world, targets, true, [], progress => { last = progress.checked; });
        clearInterval(timer);
        assert.deepEqual(plan.blockers, []); assert.equal(plan.operations.length, 0);
        assert.equal(plan.checked, actors * (1 + items) + 1 + actors * (2 + Math.ceil(items / 4)) + 1);
        assert.equal(last, plan.checked); assert.ok(ticks > 0, 'HTTP loop continues while worker checks complete inventory');
        counts.push({ actors, items: actors * items, effects: actors * (2 + Math.ceil(items / 4)), checked: plan.checked, ms: Date.now() - start, responsiveTicks: ticks });
    }
    console.log(JSON.stringify({ capacity: counts }));
};
cases['legacy-capacity'] = async root => {
    const candidate = createMaintenanceCandidate(root);
    const file = path.join(root, 'migrations/1.0.0/definition.json');
    const definition = JSON.parse(fs.readFileSync(file, 'utf8'));
    definition.steps = [definition.steps[1]];
    definition.steps[0].dependencies = []; definition.steps[0].targets = ['ActiveEffect'];
    definition.steps[0].reads = { targets: ['Actor', 'Item', 'ActorDelta'] };
    fs.writeFileSync(file, JSON.stringify(definition));
    fs.writeFileSync(path.join(root, 'migrations/1.0.0/effect.check.cjs'), "module.exports=()=>({status:'current'})");
    fs.writeFileSync(path.join(root, 'migrations/1.0.0/effect.verify.cjs'), "module.exports=()=>({valid:true})");
    const inventory = maintenanceInventory(30, 30, true);
    const targets = inventory.actors.flatMap(row => expandMigrationTargets(`Actor.${row._id}`, 'Actor', row));
    const started = Date.now();
    const plan = planWorldMigrations(root, discoverMigrations(root, candidate.info)!, world, targets, true);
    assert.equal(plan.checked, 300); assert.deepEqual(plan.blockers, []);
    console.log(JSON.stringify({ legacyComplete: plan.checked, elapsedMs: Date.now() - started }));
};
cases['legacy-journal'] = async root => {
    const candidate = fixture(path.join(root, 'candidate')); const catalog = discoverMigrations(candidate.root, candidate.info)!;
    const plan = planWorldMigrations(candidate.root, catalog, world, expandMigrationTargets('Actor.a', 'Actor', { _id: 'a', system: { fixed: false } }));
    const journal = new UpgradeJournal(path.join(root, 'journal'));
    const job: UpgradeJob = { id: 'preview', jobId: 'old-job', moduleId: 'fixture', candidateVersion: '1.0.0', artifactDigest: candidate.artifactDigest,
        catalogDigest: catalog.digest, treeDigest: candidate.artifactDigest, stepDigests: { 'fix-key': catalog.steps[0].digest }, plan, expiresAt: 1,
        phase: 'recovery-required', administrator: 'admin', backupAcknowledged: true, backupWarningRevision: 1, idempotencyKey: 'old-key',
        candidateRoot: candidate.root, leaseToken: 'old-lease', possibleWrite: true,
        outcomes: { '0:fix-key:Actor.a': { state: 'confirmed', before: plan.operations[0].sourceHash, post: plan.operations[0].effects['Actor.a'] } } };
    fs.mkdirSync(path.join(root, 'journal/jobs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'journal/jobs/old-job.json'), JSON.stringify(job)); // real 0.19 inline format
    const restored = journal.job(job.jobId); restored.leaseToken = 'new-verified-lease'; journal.save(restored);
    assert.deepEqual(new UpgradeJournal(journal.root).job(job.jobId).outcomes, job.outcomes, 'lease/phase updates cannot discard old inline confirmation evidence');
};
export async function run(): Promise<void> {
    for (const id of Object.keys(cases)) {
        const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--case', id], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 });
        assert.equal(result.status, 0, `${id}: ${result.stdout}\n${result.stderr}`);
    }
    console.log(`Complete-maintenance correctness: ${Object.keys(cases).length} cases passed`);
}
if (import.meta.url === `file://${process.argv[1]}`) {
    const id = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : '';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-complete-maintenance-'));
    (id ? cases[id](root) : run()).catch(error => { console.error(error); process.exitCode = 1; })
        .finally(() => fs.rmSync(root, { recursive: true, force: true }));
}
