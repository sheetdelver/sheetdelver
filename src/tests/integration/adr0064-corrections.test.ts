import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initDataDir, resolveDataDir } from '@server/core/paths';
import { loadConfig } from '@server/core/config';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { preparedActorStore } from '@server/core/documents/prepared/actors/PreparedActorStore';
import { primaryDocumentCacheCoordinator } from '@server/core/documents/primary/PrimaryDocumentCacheCoordinator';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { worldWorkGate, WorldWorkGate } from '@server/core/world/WorldWorkGate';
import { serviceAccountAuthority } from '@server/core/world/ServiceAccountAuthority';
import { systemService } from '@server/services/world/SystemService';
import { CoreSocket } from '@server/core/foundry/sockets/CoreSocket';
import { FoundryEventIngress } from '@server/services/world/FoundryEventIngress';
import { moduleWorldContext } from '@server/services/world/ModuleWorldContextService';
import { createHostUpgradeCoordinator, freshMigrationSnapshot, getUpgradeJournal, installedUpgradeCandidate } from '@server/services/world/migrations/ModuleUpgradeService';
import { compendiumStore } from '@server/core/compendium/CompendiumStore';
import { prepareSourceCandidate } from '@server/services/world/migrations/sourceCandidates';
import { WorldBootstrapper, worldBootstrapper } from '@server/services/world/WorldBootstrapper';
import { ModuleUpgradeCoordinator } from '@server/services/world/migrations/ModuleUpgradeCoordinator';
import { UpgradeJournal } from '@server/services/world/migrations/UpgradeJournal';
import { applyMigrationPatch, planWorldMigrations, sourceHash } from '@server/services/world/migrations/planner';
import { setMaintenanceComputationSignal, saveMaintenanceMode, readMaintenanceMode, maintenanceFile } from '@core/world/MaintenanceMode';
import { expandMigrationTargets } from '@server/services/world/migrations/targets';
import { discoverMigrations, migrationDirectoryDigest } from '@modules/registry/migrations/catalog';
import { packageMigrations } from '@modules/registry/migrations/compile';
import { BrowserWorldRuntime, observeWorldRuntime, worldRuntimeHeaders } from '@client/ui/api/worldRuntime';
import { refreshRegistry, enableModule } from '@modules/registry/server';
import { checkInstalledWorldCompatibility, getMigrationCompatibilityDiagnostic } from '@server/services/world/migrations/installedWorldCompatibility';
import { previewModuleSource, applyModuleSource } from '@server/services/world/migrations/sourceCandidates';
import { createAdminRouter } from '@server/routes/admin/createAdminRouter';
import { createAdminAccount } from '@server/security/adminCredentialStore';
import { adminSessionManager, createAdminSessionClaims } from '@server/security/adminSessionService';
import { dispatchCoreMutation } from '@server/core/world/WorldWorkGate';
import express from 'express';
import { createHook } from 'node:async_hooks';
import type { MigrationTarget } from '@shared/sdk/migrations';
import type { WorldSettingDeclaration } from '@shared/sdk/world';
import { fixture, world } from '../unit/world/module-world-migrations.test';

const cases: Record<string, (root: string) => Promise<void>> = {};
const declarations: WorldSettingDeclaration[] = [{ key: 'fixture.variant', scope: 'world', systemVersion: '>=1.0.0 <2.0.0',
    schema: { type: 'boolean' }, affectsPreparation: true, exposure: 'authenticated' }];

cases['CR64-29-local-workspace'] = async root => {
    initDataDir(root);
    const source = fixture(path.join(root, 'source'));
    fs.writeFileSync(path.join(source.root, 'logic.js'), 'export default class Adapter {}');
    fs.writeFileSync(path.join(source.root, 'ui.js'), 'export default {}');
    fs.mkdirSync(path.join(source.root, 'temp'));
    const file = fs.openSync(path.join(source.root, 'temp', 'unused-build.bin'), 'w');
    try { fs.ftruncateSync(file, 600 * 1024 * 1024); } finally { fs.closeSync(file); }
    const candidate = await prepareSourceCandidate(source.root, source.info, 'local');
    fs.writeFileSync(path.join(source.root, 'temp', 'report.txt'), 'unrelated test output');
    const refreshed = await prepareSourceCandidate(source.root, source.info, 'local');
    assert.equal(candidate.sourceDigest, refreshed.sourceDigest, 'unrelated local output must not affect the approved module inputs');
    assert.equal(candidate.artifactDigest, refreshed.artifactDigest, 'compiled migration bytes stay identical');
};

cases['CR64-29-source-approval-recovery'] = async root => {
    initDataDir(root);
    for (const mode of ['workspace', 'before-approval', 'restart', 'preparation'] as const) {
        const source = fixture(path.join(root, mode, 'source'));
        const logic = path.join(source.root, 'logic.js');
        fs.writeFileSync(logic, 'export default class Adapter {}');
        fs.writeFileSync(path.join(source.root, 'ui.js'), 'export default {}');
        const candidate = await prepareSourceCandidate(source.root, source.info, 'local');
        let journal = new UpgradeJournal(path.join(root, mode, 'journal'));
        const targets = expandMigrationTargets('Actor.a', 'Actor', { _id: 'a', system: { fixed: false } });
        let writes = 0, activated = false;
        const coordinator = () => new ModuleUpgradeCoordinator({
            journal, gate: new WorldWorkGate(), snapshot: async () => ({ world, targets: structuredClone(targets) }),
            assertAuthority: () => {}, promote: async job => { job.fileTransition = 'registered'; }, restart: () => {},
            prepare: async () => { if (mode === 'preparation') fs.appendFileSync(logic, '\n// changed while preparing'); },
            activate: async () => { activated = true; }, rollbackFiles: async () => {},
            write: async (target, updates, fence) => { fence(); writes++; targets[0].source = applyMigrationPatch(target.source, updates); },
        });
        const preview = await coordinator().preview(candidate);
        if (mode === 'before-approval') {
            fs.appendFileSync(logic, '\n// edited after advisory preview');
            await assert.rejects(coordinator().approve(candidate, { planId: preview.id, idempotencyKey: 'changed-before-approval',
                administrator: 'fixture-admin', backupAcknowledged: true }), /source changed/);
            assert.equal(journal.jobs().length, 0, 'stale source cannot acquire durable mutation authority');
            assert.equal(writes, 0);
            continue;
        }
        fs.mkdirSync(path.join(source.root, 'notes'));
        fs.writeFileSync(path.join(source.root, 'notes', 'developer.md'), 'unrelated working notes');
        const job = await coordinator().approve(candidate, { planId: preview.id, idempotencyKey: `local-source-${mode}`,
            administrator: 'fixture-admin', backupAcknowledged: true });
        journal = new UpgradeJournal(journal.root);
        const durable = journal.job(job.jobId);
        assert.equal(durable.sourceDigest, candidate.sourceDigest, 'input policy is durable across journal reload');
        if (mode === 'restart') {
            fs.appendFileSync(logic, '\n// changed after approval');
            assert.throws(() => installedUpgradeCandidate(durable), /source changed/);
            await assert.rejects(coordinator().resume(job.jobId, candidate), /source changed/);
            assert.equal(writes, 0, 'changed local source is rejected before the first write');
        } else {
            fs.appendFileSync(path.join(source.root, 'notes', 'developer.md'), '\nmore notes');
            const restored = installedUpgradeCandidate(durable);
            if (mode === 'preparation') {
                await assert.rejects(coordinator().resume(job.jobId, restored), /source changed/);
                assert.equal(journal.job(job.jobId).phase, 'recovery-required');
                assert.equal(activated, false, 'changed runtime source cannot activate');
            } else {
                assert.equal((await coordinator().resume(job.jobId, restored)).phase, 'completed');
                assert.equal(activated, true);
            }
            assert.equal(writes, 1, 'the exact approved migration completes one write');
            assert.deepEqual(targets[0].source, { _id: 'a', system: { fixed: true } });
        }
    }
};

cases['CR64-18-cold-journal-http'] = async root => {
    initDataDir(root);
    const candidate = fixture(path.join(root, 'candidate'));
    const catalog = discoverMigrations(candidate.root, candidate.info)!;
    const targets = Array.from({ length: 160 }, (_, i) => expandMigrationTargets(`Actor.a${i}`, 'Actor', { _id: `a${i}`, system: { fixed: false } })).flat();
    const plan = planWorldMigrations(candidate.root, catalog, world, targets);
    const journal = getUpgradeJournal();
    const preview = { id: 'cold-plan', moduleId: 'fixture', candidateVersion: '1.0.0', artifactDigest: candidate.artifactDigest,
        catalogDigest: catalog.digest, treeDigest: candidate.artifactDigest, stepDigests: {}, expiresAt: Date.now() + 60_000, plan };
    const app = express(); app.get('/status', (_req, res) => res.json({ alive: true }));
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/status`;
    const original = fs.fsyncSync; let mainSyncs = 0; let polls = 0; let maxGap = 0; let last = Date.now();
    const timer = setInterval(() => { maxGap = Math.max(maxGap, Date.now() - last); last = Date.now();
        void fetch(url).then(response => { assert.equal(response.status, 200); polls++; }); }, 20);
    // Model slow durable storage on the HTTP thread, not a fake successful write.
    // Owned storage workers do not inherit this main-thread instrumentation.
    fs.fsyncSync = fd => { mainSyncs++; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); original(fd); };
    try {
        await new Promise(resolve => setTimeout(resolve, 50));
        await journal.savePreview(preview);
        const restored = await journal.preview(preview.id); assert.equal(restored.plan.digest, plan.digest);
        const changed = { ...plan, world: { ...plan.world, identity: { ...plan.world.identity, contextRevision: 2 } } };
        const { digest: _digest, diagnostics: _diagnostics, ...body } = changed; changed.digest = sourceHash(body);
        const cancel = new AbortController(); setMaintenanceComputationSignal(cancel.signal);
        const watcher = fs.watch(path.join(journal.root, 'plan-content'), (_event, name) => { if (name?.endsWith('.tmp')) cancel.abort(); });
        try { await assert.rejects(journal.savePreview({ ...preview, id: 'cancelled-storage', plan: changed }), /stopped|abort/i); }
        finally { watcher.close(); setMaintenanceComputationSignal(); }
        await journal.drain().catch(() => {});
        await journal.savePreview({ ...preview, id: 'recovered-storage', plan: changed });
        assert.equal((await journal.preview('recovered-storage')).plan.digest, changed.digest, 'a retired writer is joined before the replacement writes');
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(mainSyncs, 0, 'plan encoding/persistence/loading must not fsync on the HTTP event loop');
        assert.ok(polls >= 3); assert.ok(maxGap < 500, `cold storage starved HTTP: ${maxGap}ms`);
    } finally { fs.fsyncSync = original; clearInterval(timer); await (journal as any).close?.(); await new Promise<void>(resolve => server.close(() => resolve())); }
};

export async function host(root: string) {
    for (const key of Object.keys(process.env)) if (/^(FOUNDRY_|APP_)/.test(key)) delete process.env[key];
    initDataDir(resolveDataDir(['--data-dir', root]));
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config/settings.yaml'), JSON.stringify({ app: { host: '127.0.0.1', protocol: 'http', port: 31990 },
        foundry: { host: 'offline.invalid', protocol: 'http', port: 30000, username: 'service' } }));
    await loadConfig();
    const users = [{ _id: 'service', name: 'service', role: 4 }];
    const data = { world: { id: 'w1' }, system: { id: 'fixture', version: '1.0.0' }, release: { generation: 14, build: '367' }, users, userId: 'service' };
    worldStateStore.seed(data);
    const source = { hp: 1, fixed: true, variant: false, fail: '', reads: [] as string[], writes: [] as string[], onRead: undefined as ((type: string) => void) | undefined };
    class Wire extends CoreSocket {
        constructor() { super({ url: 'http://offline.invalid:30000', username: 'service' }); this.userId = 'service';
            this.isSocketConnected = true; this.socket = { connected: true } as never;
            this.setOperationGuard(send => dispatchCoreMutation(send)); }
        override async getBootstrapSnapshot() { return { gameData: data }; }
        // Only the upstream wire is controlled, not host snapshot/dispatch/ingress.
        override async emitSocketEvent<T>(event: string, ...payloads: any[]): Promise<T> {
            assert.equal(event, 'modifyDocument');
            const { type, action, operation } = payloads[0];
            if (action === 'update') {
                assert.equal(type, 'Actor'); source.writes.push(operation.updates[0]._id);
                source.fixed = operation.updates[0]['system.fixed'];
            } else { assert.equal(action, 'get'); source.reads.push(type); source.onRead?.(type); }
            if (source.fail === type) throw new Error('controlled source read failure');
            return { type, action, operation, result: type === 'Actor' ? [{ _id: 'a', name: 'A', type: 'character', system: { hp: source.hp, fixed: source.fixed }, items: [], effects: [] }]
                : type === 'User' ? users : type === 'Setting' ? [{ _id: 'setting', key: 'fixture.variant', value: JSON.stringify(source.variant) }] : [] } as T;
        }
    }
    const transport = new Wire();
    new FoundryEventIngress().attach(transport);
    // Only the upstream transport is controlled. Host snapshot and lifecycle
    // services under test are their production implementations.
    systemService.getSystemClient = () => transport as never;
    await primaryDocumentCacheCoordinator.seedAll(transport as never);
    serviceAccountAuthority.verify(data, 'service', 'service');
    moduleWorldContext.configure('http://offline.invalid:30000', world.identity, declarations);
    return { source, transport, data };
}

cases['CR64-18-diagnostic-progress'] = async root => {
    await host(root); const candidate = fixture(path.join(root, 'candidate')); const journal = getUpgradeJournal();
    saveMaintenanceMode({ schemaVersion: 1, id: 'progress-only', moduleId: 'fixture', stage: 'planning', drained: true, updatedAt: 1 });
    const before = fs.readFileSync(maintenanceFile(), 'utf8'), sync = fs.fsyncSync; let mainSyncs = 0;
    fs.fsyncSync = fd => { mainSyncs++; sync(fd); };
    try {
        await createHostUpgradeCoordinator().preview(candidate);
        assert.equal(readMaintenanceMode()?.progress?.checked, 1, 'actual host progress remains visible');
        assert.equal(mainSyncs, 0, 'diagnostic counters must not fsync on the HTTP thread');
        assert.equal(fs.readFileSync(maintenanceFile(), 'utf8'), before, 'progress is not durable authority');
        const current = readMaintenanceMode()!; current.stage = 'review'; saveMaintenanceMode(current);
        assert.equal(JSON.parse(fs.readFileSync(maintenanceFile(), 'utf8')).progress.checked, 1, 'durable stage transitions checkpoint counters');
        fs.writeFileSync(maintenanceFile(), JSON.stringify({ ...JSON.parse(before), id: 'replacement-operation' }));
        assert.equal(readMaintenanceMode()?.progress, undefined, 'a replacement operation cannot inherit local counters');
    } finally { fs.fsyncSync = sync; await journal.close(); }
};

cases['CR64-17-final-readiness'] = async root => {
    const { source } = await host(root); const authored = fixture(path.join(root, 'authored'));
    const directory = path.join(root, 'modules/fixture'); fs.mkdirSync(directory, { recursive: true });
    await packageMigrations(authored.root, directory, authored.info);
    fs.writeFileSync(path.join(directory, 'info.json'), JSON.stringify({ ...authored.info, worldSettings: declarations }));
    fs.writeFileSync(path.join(directory, 'logic.js'), 'export class Adapter {systemId="fixture";match(){return true}}');
    fs.writeFileSync(path.join(directory, 'ui.js'), 'export default {}'); refreshRegistry(); enableModule('fixture');
    let prepared = false; let armed = false; let changed = false;
    source.onRead = type => { if (prepared && type === 'Actor') armed = true; };
    const observer = createHook({ init(_id, type) {
        if (armed && !changed && ['WORKER', 'FSREQPROMISE'].includes(type)) { changed = true; queueMicrotask(() => { source.fixed = false; actorStore.observeMutation(); }); }
    } }).enable();
    try { await assert.rejects(checkInstalledWorldCompatibility('fixture', async () => { prepared = true; }), /scope changed|retired|stale/); }
    finally { observer.disable(); }
    assert.equal(changed, true); assert.equal(worldWorkGate.hasBlock('migration-compatibility'), true);
    assert.equal(getMigrationCompatibilityDiagnostic()?.phase, 'post-preparation-source-check');
    source.onRead = undefined; source.fixed = true; actorStore.observeMutation();
    await checkInstalledWorldCompatibility('fixture'); assert.equal(worldWorkGate.hasBlock('migration-compatibility'), false, 'fresh validation can recover');
};

cases['CR64-17-completion-storage-await'] = async root => {
    const candidate = fixture(path.join(root, 'candidate'));
    const journal = new UpgradeJournal(path.join(root, 'journal')); const gate = new WorldWorkGate();
    let current = true; let fixed = false;
    const save = journal.save.bind(journal);
    const storage = { root: journal.root, lockRoot: journal.lockRoot, leaseKey: journal.leaseKey.bind(journal),
        acquire: journal.acquire.bind(journal), release: journal.release.bind(journal), assertLease: journal.assertLease.bind(journal),
        assertActive: journal.assertActive.bind(journal), savePreview: journal.savePreview.bind(journal), preview: journal.preview.bind(journal),
        job: journal.job.bind(journal), jobs: journal.jobs.bind(journal), recoverJob: journal.recoverJob.bind(journal), sourceCandidate: journal.sourceCandidate.bind(journal),
        saveSourceCandidate: journal.saveSourceCandidate.bind(journal),
        async save(job: Parameters<UpgradeJournal['save']>[0]) { save(job); if (job.phase === 'completed') { await new Promise(resolve => setImmediate(resolve)); current = false; } } };
    const coordinator = new ModuleUpgradeCoordinator({ journal: storage, gate, assertAuthority() {},
        snapshot: async () => ({ world, targets: [{ uuid: 'Actor.a', kind: 'Actor', source: { _id: 'a', system: { fixed } } }],
            assertCurrent() { if (!current) throw new Error('source retired during completion storage'); } }),
        write: async (_target, updates) => { fixed = updates['system.fixed'] as boolean; }, promote: async () => {},
        prepare: async () => {}, activate: async () => {}, rollbackFiles: async () => {}, restart() {} });
    const preview = await coordinator.preview(candidate);
    const approved = await coordinator.approve(candidate, { planId: preview.id, administrator: 'admin', idempotencyKey: 'completion-await', backupAcknowledged: true });
    await assert.rejects(coordinator.resume(approved.jobId, candidate), /source retired during completion storage/);
    assert.equal(journal.job(approved.jobId).phase, 'recovery-required');
    assert.equal(journal.job(approved.jobId).worldDataStatus, 'maintenance');
    assert.equal(gate.hasBlock('module-upgrade'), true, 'durability ACK cannot release a now-stale preparation');
    journal.assertLease(journal.job(approved.jobId));
};

for (const boundary of ['preview', 'promotion'] as const) cases[`CR64-18-${boundary}-storage-await`] = async root => {
    const candidate = fixture(path.join(root, 'candidate')); const journal = new UpgradeJournal(path.join(root, 'journal'));
    let current = true; let promoted = false;
    const savePreview = journal.savePreview.bind(journal), save = journal.save.bind(journal);
    journal.savePreview = async preview => { savePreview(preview); if (boundary === 'preview') { await new Promise(resolve => setImmediate(resolve)); current = false; } };
    journal.save = async job => { save(job); if (boundary === 'promotion' && job.phase === 'installing') { await new Promise(resolve => setImmediate(resolve)); current = false; } };
    const coordinator = new ModuleUpgradeCoordinator({ journal, gate: new WorldWorkGate(), assertAuthority() {},
        snapshot: async () => ({ world, targets: [{ uuid: 'Actor.a', kind: 'Actor', source: { _id: 'a', system: { fixed: false } } }],
            assertCurrent() { if (!current) throw new Error('source retired during storage'); } }),
        write: async () => {}, promote: async () => { promoted = true; }, prepare: async () => {}, activate: async () => {}, rollbackFiles: async () => {}, restart() {} });
    if (boundary === 'preview') await assert.rejects(coordinator.preview(candidate), /source retired during storage/);
    else {
        const preview = await coordinator.preview(candidate);
        await assert.rejects(coordinator.approve(candidate, { planId: preview.id, administrator: 'admin', idempotencyKey: 'promotion-await', backupAcknowledged: true }), /source retired during storage/);
        assert.equal(promoted, false, 'retired source must not reach file promotion after a durable phase await');
    }
};

cases['CR64-01'] = async root => {
    const { source } = await host(root);
    preparedActorStore.configure({ prepareActorData: (actor: any, context: any) => ({ ...actor, id: actor._id, derived: { variant: context.world.settings['fixture.variant'] } }) } as any,
        { worldEpoch: 1, systemId: 'fixture', world: moduleWorldContext.snapshot(), contextRevision: moduleWorldContext.snapshot().identity.contextRevision });
    preparedActorStore.rebuildAll();
    const candidate = fixture(path.join(root, 'candidate'));
    const catalog = discoverMigrations(candidate.root, { ...candidate.info, worldSettings: declarations })!;
    const before = { source: actorStore.get('a'), prepared: preparedActorStore.getRequired('a'), context: moduleWorldContext.snapshot() };
    source.hp = 2; source.variant = true; source.reads = [];
    const preview = await freshMigrationSnapshot(catalog);
    assert.equal(preview.targets.find(row => row.uuid === 'Actor.a')!.source.system && (preview.targets[0].source.system as any).hp, 2);
    assert.deepEqual(actorStore.get('a'), before.source, 'CR64-01 preview must not silently replace serving Actor sources');
    assert.deepEqual(preparedActorStore.getRequired('a'), before.prepared);
    assert.deepEqual(moduleWorldContext.snapshot(), before.context);
    assert.equal(worldWorkGate.isOpen(), true);
    assert.ok(!source.reads.includes('ChatMessage') && !source.reads.includes('Combat'), 'Actor preview does not sweep unrelated document domains');
    source.fail = 'Actor';
    await assert.rejects(freshMigrationSnapshot(catalog), /controlled/);
    assert.deepEqual(actorStore.get('a'), before.source, 'failed preview preserves serving state too');
    source.fail = ''; source.onRead = type => { if (type === 'Setting') moduleWorldContext.touchDependencies(); };
    await assert.rejects(freshMigrationSnapshot(catalog), /scope changed/, 'interleaved context ingress invalidates the isolated snapshot');
};

cases['CR64-02'] = async root => {
    const candidate = fixture(path.join(root, 'candidate'));
    const directory = path.join(candidate.root, 'migrations/1.0.0');
    const definition = JSON.parse(fs.readFileSync(path.join(directory, 'definition.json'), 'utf8'));
    definition.steps[0].paths = ['system.value']; definition.steps[0].reads = { targets: ['Actor'] };
    fs.writeFileSync(path.join(directory, 'definition.json'), JSON.stringify(definition));
    const valid = "target.uuid!=='Actor.a'||target.source.system.value===references.find(row=>row.uuid==='Actor.b').source.system.value";
    fs.writeFileSync(path.join(directory, 'check.cjs'), `module.exports=({target,references})=>({status:(${valid})?'current':'migration-needed'})`);
    fs.writeFileSync(path.join(directory, 'plan.cjs'), "module.exports=({references})=>({status:'patch',updates:{'system.value':references.find(row=>row.uuid==='Actor.b').source.system.value}})");
    fs.writeFileSync(path.join(directory, 'verify.cjs'), `module.exports=({target,references})=>({valid:(${valid})})`);
    const sources: MigrationTarget[] = ['a', 'b'].map((id, i) => ({ uuid: `Actor.${id}`, kind: 'Actor', source: { _id: id, system: { value: i * 10 } } }));
    const journal = new UpgradeJournal(path.join(root, 'journal')); let writes = 0;
    const coordinator = new ModuleUpgradeCoordinator({ journal, gate: new WorldWorkGate(), snapshot: async () => ({ world, targets: structuredClone(sources) }),
        assertAuthority: () => {}, promote: async () => {}, restart: () => {}, prepare: async () => {}, activate: async () => {}, rollbackFiles: async () => {},
        write: async (target, updates, fence) => { fence(); writes += 1; sources.find(row => row.uuid === target.uuid)!.source = applyMigrationPatch(target.source, updates); } });
    const preview = await coordinator.preview(candidate);
    const job = await coordinator.approve(candidate, { planId: preview.id, idempotencyKey: 'reference-approval', administrator: 'test-admin', backupAcknowledged: true });
    sources[1].source.system = { value: 20 };
    await assert.rejects(coordinator.resume(job.jobId, candidate));
    assert.equal(writes, 0, 'CR64-02 changed reference must reject before native intent/send');
    assert.equal(journal.job(job.jobId).possibleWrite, false);
};

cases['CR64-03'] = async root => {
    await host(root);
    const source = fixture(path.join(root, 'source')); const packaged = path.join(root, 'packaged'); fs.mkdirSync(packaged);
    await packageMigrations(source.root, packaged, source.info);
    fs.writeFileSync(path.join(packaged, 'info.json'), JSON.stringify(source.info));
    const original = discoverMigrations(packaged, source.info)!;
    const repair = await prepareSourceCandidate(packaged, source.info, 'managed');
    assert.equal(discoverMigrations(repair.root, repair.info)!.digest, original.digest, 'CR64-03 managed repair must preserve packaged catalog/hook bytes');
    assert.deepEqual(discoverMigrations(repair.root, repair.info)!.steps.map(step => step.digest), original.steps.map(step => step.digest));
    assert.equal(migrationDirectoryDigest(packaged), repair.sourceDigest);
};

async function packHost(root: string) {
    const current = await host(root);
    current.source.fixed = false;
    const candidate = fixture(path.join(root, 'candidate'));
    const directory = path.join(candidate.root, 'migrations/1.0.0');
    const file = path.join(directory, 'definition.json');
    const definition = JSON.parse(fs.readFileSync(file, 'utf8'));
    definition.steps[0].reads = { packs: ['system.references', 'system.barrier'] };
    fs.writeFileSync(file, JSON.stringify(definition));
    const value = "references.find(row=>row.uuid==='Compendium.system.references.Actor.ref').source.system.value";
    fs.writeFileSync(path.join(directory, 'check.cjs'), `module.exports=({target,references})=>({status:target.source.system.fixed===${value}?'current':'migration-needed'})`);
    fs.writeFileSync(path.join(directory, 'plan.cjs'), `module.exports=({references})=>({status:'patch',updates:{'system.fixed':${value}}})`);
    fs.writeFileSync(path.join(directory, 'verify.cjs'), `module.exports=({target,references})=>({valid:target.source.system.fixed===${value}})`);
    const wire = { value: 10, barrier: undefined as (() => Promise<void>) | undefined };
    for (const packId of ['system.references', 'system.barrier']) {
        compendiumStore.setPackMetadata(packId, { id: packId, type: 'Actor', packageType: 'system' });
        compendiumStore.setPackIndex(packId, compendiumStore.getPackMetadata(packId)!, [{ _id: 'ref', name: 'Cached reference' }]);
    }
    const original = current.transport.emitSocketEvent.bind(current.transport);
    current.transport.emitSocketEvent = async <T>(event: string, ...payloads: any[]): Promise<T> => {
        const { type, action, operation } = payloads[0];
        if (action === 'get' && operation.pack) {
            if (operation.pack === 'system.barrier') await wire.barrier?.();
            return { type, action, operation, result: operation.pack === 'system.references'
                ? [{ _id: 'ref', system: { value: wire.value } }] : [] } as T;
        }
        return original<T>(event, ...payloads);
    };
    const mutate = () => {
        wire.value = 20;
        current.transport.emit('foundry:modifyDocument', { type: 'Actor', action: 'update',
            operation: { pack: 'system.references', updates: [{ _id: 'ref', 'system.value': 20 }] },
            result: [{ _id: 'ref', system: { value: 20 } }] });
    };
    return { ...current, candidate, wire, mutate };
}

cases['CR64-06-snapshot'] = async root => {
    const { candidate, mutate } = await packHost(root);
    const snapshot = await freshMigrationSnapshot(discoverMigrations(candidate.root, candidate.info)!);
    const metadata = compendiumStore.listPackMetadata();
    mutate(); // accepted ingress must retire synchronously, not after hydration
    assert.equal(compendiumStore.getPackIndex('system.references'), null);
    assert.deepEqual(compendiumStore.listPackMetadata(), metadata);
    assert.throws(() => snapshot.assertCurrent(), /changed|retired|stale/, 'CR64-06 observed pack ingress must retire its migration snapshot');
};

cases['CR64-06-ingress-matrix'] = async root => {
    const { candidate, transport, source } = await packHost(root);
    const catalog = discoverMigrations(candidate.root, candidate.info)!;
    assert.equal(worldBootstrapper.getActiveAdapter(), null, 'maintenance observations cannot depend on an adapter');
    worldWorkGate.block('module-upgrade', { phase: 'migrating', message: 'Controlled maintenance' });
    const pack = 'system.references';
    const document = (action: string, id = 'ref') => ({ type: 'Actor', action, operation: { pack }, result: action === 'delete' ? [id] : [{ _id: id, system: { value: 10 } }] });
    const events: Array<[string, unknown]> = [
        ...['update', 'create', 'delete'].map(action => ['foundry:modifyDocument', document(action)] as [string, unknown]),
        ['foundry:modifyDocumentBatch', { results: [document('update'), document('create', 'new'), document('delete', 'new')] }],
        ['foundry:pmAutosave', { uuid: 'Compendium.system.references.Actor.ref#system.description.value', html: '<p>Changed</p>' }],
        ['foundry:documentDispatchConfirmed', { response: document('update') }],
    ];
    for (const [event, payload] of events) {
        const snapshot = await freshMigrationSnapshot(catalog);
        const before = compendiumStore.getPackContentRevision(pack);
        transport.emit(event, payload);
        assert.ok(compendiumStore.getPackContentRevision(pack) > before, `${event}: accepted observation advances synchronously`);
        assert.throws(snapshot.assertCurrent, /scope changed/, `${event}: actual host snapshot is retired`);
        await new Promise(resolve => setImmediate(resolve));
    }
    const unchanged = await freshMigrationSnapshot(catalog);
    const before = compendiumStore.getPackContentRevision(pack);
    await transport.readDocumentSources('Actor', { pack });
    await transport.dispatchDocumentSocket('Actor', 'get', { pack }); // real acknowledgement ingress too
    await freshMigrationSnapshot(catalog);
    compendiumStore.setPackIndex(pack, compendiumStore.getPackMetadata(pack)!, [{ _id: 'ref', name: 'Rehydrated' }]);
    for (const payload of [document('get'), { ...document('update'), error: 'rejected' }]) transport.emit('foundry:modifyDocument', payload);
    transport.emit('foundry:modifyDocument', { ...document('update'), operation: { pack: 'system.unrelated' } });
    assert.equal(compendiumStore.getPackContentRevision(pack), before, 'reads, cache population, failed and unrelated content do not retire this pack');
    unchanged.assertCurrent();
    assert.deepEqual(source.writes, [], 'snapshot/ingress tests remain read-only');
};

cases['CR64-06-world-pack'] = async root => {
    const { candidate, transport } = await packHost(root);
    const file = path.join(candidate.root, 'migrations/1.0.0/definition.json');
    const definition = JSON.parse(fs.readFileSync(file, 'utf8'));
    definition.steps[0].targets = ['WorldPack']; definition.steps[0].reads = {};
    fs.writeFileSync(file, JSON.stringify(definition));
    const pack = 'world.targets';
    compendiumStore.setPackMetadata(pack, { id: pack, type: 'Actor', packageType: 'world', locked: false });
    const original = transport.emitSocketEvent.bind(transport);
    transport.emitSocketEvent = async <T>(event: string, ...payloads: any[]): Promise<T> => {
        const { type, action, operation } = payloads[0];
        return operation.pack === pack ? { type, action, operation, result: [{ _id: 'packed', system: { fixed: false } }] } as T : original<T>(event, ...payloads);
    };
    const catalog = discoverMigrations(candidate.root, candidate.info)!;
    const snapshot = await freshMigrationSnapshot(catalog);
    assert.ok(snapshot.targets.some(target => target.uuid === 'Compendium.world.targets.Actor.packed' && !target.readOnly));
    transport.emit('foundry:modifyDocument', { type: 'Actor', action: 'update', operation: { pack }, result: [{ _id: 'packed', system: { fixed: true } }] });
    assert.throws(snapshot.assertCurrent, /scope changed/, 'writable pack content is fenced without a reads.packs declaration');
    for (const action of ['create', 'delete']) {
        const before = compendiumStore.getPackContentRevision(pack);
        transport.emit('foundry:manageCompendium', { request: { action, data: { collection: pack } },
            result: action === 'delete' ? pack : { collection: pack, type: 'Actor', packageType: 'world', locked: false } });
        assert.ok(compendiumStore.getPackContentRevision(pack) > before, `catalog ${action} also passes the shared observation owner`);
    }
    await new Promise(resolve => setImmediate(resolve));
};

cases['CR64-06-adapter-lifecycle'] = async root => {
    const { candidate, transport, mutate } = await packHost(root);
    const installed = path.join(root, 'modules/fixture'); fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, 'info.json'), JSON.stringify({ ...candidate.info, worldSettings: declarations,
        compendiumPacks: { packs: [{ id: 'system.references', type: 'Actor', hydrate: false }] } }));
    let initialized!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { initialized = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const scope = globalThis as typeof globalThis & { cr64Prepare?: () => Promise<void> };
    scope.cr64Prepare = async () => { initialized(); await pending; };
    fs.writeFileSync(path.join(installed, 'logic.js'), `export class Adapter { systemId='fixture'; match(){return true}
        async initialize(){await globalThis.cr64Prepare()}
        normalizeActorData(actor){return {...actor,id:actor._id,img:'',derived:{}}} }`);
    fs.writeFileSync(path.join(installed, 'ui.js'), 'export default {}');
    refreshRegistry(); enableModule('fixture');
    const bootstrap = worldBootstrapper.bootstrap(transport);
    try {
        await started;
        assert.ok(worldBootstrapper.getActiveAdapter()); assert.equal(worldBootstrapper.isReady(), false);
        const catalog = discoverMigrations(candidate.root, candidate.info)!;
        const preparing = await freshMigrationSnapshot(catalog);
        mutate();
        assert.throws(preparing.assertCurrent, /scope changed/, 'adapter initialize/hydration is not the content authority');
        release(); await bootstrap;
        assert.equal(worldBootstrapper.isReady(), true);
        await worldBootstrapper.refreshWorldContext('system.references');
        const serving = await freshMigrationSnapshot(catalog);
        mutate();
        assert.throws(serving.assertCurrent, /scope changed/, 'declared-pack observation retires scope before async context refresh');
        await new Promise(resolve => setImmediate(resolve));
        await worldBootstrapper.refreshWorldContext('system.references');
    } finally { release(); await bootstrap; worldBootstrapper.reset('fixture-cleanup'); delete scope.cr64Prepare; }
};

cases['CR64-06-before-intent'] = async root => {
    const { candidate, source, wire, mutate } = await packHost(root);
    const coordinator = createHostUpgradeCoordinator({ promote: async () => {}, restart: () => {}, prepare: async () => {}, activate: async () => {} });
    const preview = await coordinator.preview(candidate);
    const job = await coordinator.approve(candidate, { planId: preview.id, idempotencyKey: 'pack-pre-intent', administrator: 'admin', backupAcknowledged: true });
    let snapshots = 0;
    wire.barrier = async () => {
        if (++snapshots !== 2) return; // first resume read, then pre-operation read
        mutate();
        await new Promise(resolve => setImmediate(resolve)); // first pack GET has returned; second still awaits
        assert.equal(compendiumStore.getPackIndex('system.references'), null);
    };
    await assert.rejects(coordinator.resume(job.jobId, candidate));
    assert.deepEqual(source.writes, [], 'CR64-06 observed multi-pack ingress must reject before an obsolete send');
    const stopped = (await getUpgradeJournal().job(job.jobId));
    assert.equal(stopped.possibleWrite, false, 'pre-intent retirement records zero possible writes');
    assert.deepEqual(stopped.outcomes, {});
};

cases['CR64-06-final-send'] = async root => {
    const { candidate, source, transport, mutate } = await packHost(root);
    const coordinator = createHostUpgradeCoordinator({ promote: async () => {}, restart: () => {}, prepare: async () => {}, activate: async () => {} });
    const preview = await coordinator.preview(candidate);
    const job = await coordinator.approve(candidate, { planId: preview.id, idempotencyKey: 'pack-final-send', administrator: 'admin', backupAcknowledged: true });
    let once = true;
    transport.setOperationGuard(send => {
        if (once) { once = false; mutate(); }
        return dispatchCoreMutation(send); // retains the production maintenance fence at the actual send
    });
    await assert.rejects(coordinator.resume(job.jobId, candidate));
    assert.deepEqual(source.writes, [], 'CR64-06 final dispatch fence rejects observed pack mutation after intent');
    const stopped = (await getUpgradeJournal().job(job.jobId));
    assert.equal(stopped.possibleWrite, true, 'never erase durable intent/possible-write evidence');
    assert.equal(stopped.outcomes['0:fix-key:Actor.a'].state, 'uncertain');
    await assert.rejects(coordinator.resume(job.jobId, candidate));
    assert.deepEqual(source.writes, [], 'old approval cannot replay after observed reference change');
    const review = await coordinator.reviewRecovery(job.jobId, candidate);
    assert.equal(review.plan.operations[0].updates['system.fixed'], 20);
    await coordinator.reapprove(job.jobId, candidate, review.id, 'admin', true);
    await coordinator.resume(job.jobId, candidate);
    const completed = (await getUpgradeJournal().job(job.jobId));
    assert.deepEqual(source.writes, ['a'], 'fresh exact approval writes the newly observed value once');
    assert.equal(source.fixed, 20);
    assert.equal(completed.priorApprovals?.length, 1, 'original evidence remains in the approval history');
    await coordinator.resume(job.jobId, candidate);
    assert.deepEqual(source.writes, ['a'], 'completed recovery does not replay');
};

for (const mode of ['partial', 'uncertain', 'changed-uncertain']) cases[`CR64-06-${mode}-recovery`] = async root => {
    const { candidate, transport, mutate, source } = await packHost(root);
    const actors = ['a', 'b'].map(_id => ({ _id, system: { fixed: false } }));
    const original = transport.emitSocketEvent.bind(transport);
    transport.emitSocketEvent = async <T>(event: string, ...payloads: any[]): Promise<T> => {
        const { type, action, operation } = payloads[0];
        if (type !== 'Actor' || operation.pack) return original<T>(event, ...payloads);
        if (action === 'update') {
            const update = operation.updates[0]; source.writes.push(update._id);
            const index = actors.findIndex(row => row._id === update._id);
            actors[index] = applyMigrationPatch(actors[index], update) as typeof actors[number];
            if (source.writes.length === 1) {
                if (mode !== 'uncertain') mutate();
                if (mode.includes('uncertain')) throw new Error('controlled lost acknowledgement after native write');
            }
        } else assert.equal(action, 'get');
        return { type, action, operation, result: structuredClone(actors) } as T;
    };
    const coordinator = createHostUpgradeCoordinator({ promote: async () => {}, restart: () => {}, prepare: async () => {}, activate: async () => {} });
    const preview = await coordinator.preview(candidate);
    assert.equal(preview.plan.operations.length, 2);
    const job = await coordinator.approve(candidate, { planId: preview.id, idempotencyKey: `pack-${mode}`, administrator: 'admin', backupAcknowledged: true });
    await assert.rejects(coordinator.resume(job.jobId, candidate));
    assert.deepEqual(source.writes, ['a'], 'no second obsolete send after the first partial/uncertain write');
    const stopped = (await getUpgradeJournal().job(job.jobId));
    assert.equal(stopped.phase, 'recovery-required'); assert.equal(stopped.possibleWrite, true);
    if (mode.includes('uncertain')) assert.equal(stopped.outcomes['0:fix-key:Actor.a'].state, 'uncertain');
    if (mode === 'uncertain') {
        await coordinator.resume(job.jobId, candidate);
        assert.deepEqual(source.writes, ['a', 'b'], 'exact native readback reconciles a lost acknowledgement without replay');
    } else {
        await assert.rejects(coordinator.resume(job.jobId, candidate));
        assert.deepEqual(source.writes, ['a'], 'changed pack cannot inherit the original approval after restart/resume');
        const revised = await coordinator.reviewRecovery(job.jobId, candidate);
        assert.ok(revised.plan.operations.every(row => row.updates['system.fixed'] === 20));
        await coordinator.reapprove(job.jobId, candidate, revised.id, 'admin', true);
        await coordinator.resume(job.jobId, candidate);
        assert.deepEqual(source.writes, ['a', 'a', 'b'], 'fresh exact repair of partial source is not automatic replay');
        assert.equal((await getUpgradeJournal().job(job.jobId)).priorApprovals?.length, 1);
    }
    const writes = [...source.writes]; await coordinator.resume(job.jobId, candidate);
    assert.deepEqual(source.writes, writes);
    assert.equal((await getUpgradeJournal().job(job.jobId)).phase, 'completed');
};

cases['CR64-02-matrix'] = async root => {
    for (const mode of ['changed', 'removed', 'new', 'pack', 'between-writes', 'uncertain', 'uncertain-second', 'sequential']) {
        const candidate = fixture(path.join(root, mode));
        const directory = path.join(candidate.root, 'migrations/1.0.0');
        const file = path.join(directory, 'definition.json'); const definition = JSON.parse(fs.readFileSync(file, 'utf8'));
        definition.steps[0].paths = ['system.value'];
        definition.steps[0].reads = mode === 'pack' ? { packs: ['system.references'] } : { targets: ['Actor'] };
        const value = "references.filter(row=>row.source.system.reference===true).reduce((sum,row)=>sum+row.source.system.value,0)";
        const valid = `target.source.system.reference===true||target.source.system.value===(${value})`;
        fs.writeFileSync(file, JSON.stringify(definition));
        fs.writeFileSync(path.join(directory, 'check.cjs'), `module.exports=({target,references})=>({status:(${valid})?'current':'migration-needed'})`);
        fs.writeFileSync(path.join(directory, 'plan.cjs'), `module.exports=({references})=>({status:'patch',updates:{'system.value':${value}}})`);
        fs.writeFileSync(path.join(directory, 'verify.cjs'), `module.exports=({target,references})=>({valid:(${valid})})`);
        const targets: MigrationTarget[] = [{ uuid: 'Actor.a', kind: 'Actor', source: { _id: 'a', system: { value: 0 } } },
            { uuid: mode === 'pack' ? 'Compendium.system.references.Actor.b' : 'Actor.b', kind: 'Actor',
                ...(mode === 'pack' ? { pack: 'system.references', readOnly: true } : {}), source: { _id: 'b', system: { reference: true, value: 10 } } }];
        if (mode === 'between-writes' || mode === 'sequential' || mode === 'uncertain-second') targets.push({ uuid: 'Actor.c', kind: 'Actor', source: { _id: 'c', system: { value: 0 } } });
        const journal = new UpgradeJournal(path.join(root, `journal-${mode}`)); let writes = 0;
        const deps = { journal, gate: new WorldWorkGate(), snapshot: async () => ({ world, targets: structuredClone(targets) }),
            assertAuthority: () => {}, promote: async () => {}, restart: () => {}, prepare: async () => {}, activate: async () => {}, rollbackFiles: async () => {},
            write: async (target: MigrationTarget, updates: Record<string, unknown>, fence: () => void) => {
                fence(); writes++; targets.find(row => row.uuid === target.uuid)!.source = applyMigrationPatch(target.source, updates);
                if (mode === 'between-writes' && writes === 1) (targets[1].source.system as any).value = 20;
                if (mode === 'uncertain' && writes === 1) throw new Error('lost acknowledgement');
                if (mode === 'uncertain-second' && writes === 2) throw new Error('lost second acknowledgement');
            } };
        let coordinator = new ModuleUpgradeCoordinator(deps);
        const preview = await coordinator.preview(candidate);
        assert.equal(preview.plan.blockers.length, 0, mode);
        const job = await coordinator.approve(candidate, { planId: preview.id, idempotencyKey: `approval-${mode}`, administrator: 'admin', backupAcknowledged: true });
        if (mode === 'changed' || mode === 'pack') (targets[1].source.system as any).value = 20;
        if (mode === 'removed') targets.splice(1, 1);
        if (mode === 'new') targets.push({ uuid: 'Actor.new', kind: 'Actor', source: { _id: 'new', system: { reference: true, value: 5 } } });
        coordinator = new ModuleUpgradeCoordinator(deps); // reload durable evidence, not callback-local approval
        if (mode === 'sequential') { await coordinator.resume(job.jobId, candidate); assert.equal(writes, 2); }
        else if (mode.startsWith('uncertain')) {
            await assert.rejects(coordinator.resume(job.jobId, candidate), /uncertain/);
            await new ModuleUpgradeCoordinator(deps).resume(job.jobId, candidate);
            assert.equal(writes, mode === 'uncertain-second' ? 2 : 1, 'post-state dependencies reconcile unknown acknowledgement without replay');
        } else {
            await assert.rejects(coordinator.resume(job.jobId, candidate));
            assert.equal(writes, mode === 'between-writes' ? 1 : 0, mode);
        }
    }
};

cases['CR64-02-cumulative'] = async root => {
    const candidate = fixture(path.join(root, 'candidate')); const directory = path.join(candidate.root, 'migrations/1.0.0');
    const file = path.join(directory, 'definition.json'); const definition = JSON.parse(fs.readFileSync(file, 'utf8'));
    const base = definition.steps[0];
    definition.steps = ['b', 'a'].map((id, index) => ({ ...base, id: `fix-${id}`, dependencies: index ? ['fix-b'] : [], paths: ['system.value'], reads: { targets: ['Actor'] },
        hooks: { check: `${id}.check.cjs`, plan: `${id}.plan.cjs`, verify: `${id}.verify.cjs` } }));
    fs.writeFileSync(file, JSON.stringify(definition));
    for (const id of ['a', 'b']) {
        const desired = id === 'b' ? '20' : "references.find(row=>row.uuid==='Actor.b').source.system.value";
        const valid = `target.uuid!=='Actor.${id}'||target.source.system.value===(${desired})`;
        fs.writeFileSync(path.join(directory, `${id}.check.cjs`), `module.exports=({target,references})=>({status:(${valid})?'current':'migration-needed'})`);
        fs.writeFileSync(path.join(directory, `${id}.plan.cjs`), `module.exports=({references})=>({status:'patch',updates:{'system.value':${desired}}})`);
        fs.writeFileSync(path.join(directory, `${id}.verify.cjs`), `module.exports=({target,references})=>({valid:(${valid})})`);
    }
    const targets: MigrationTarget[] = ['a', 'b'].map(id => ({ uuid: `Actor.${id}`, kind: 'Actor', source: { _id: id, system: { value: id === 'b' ? 10 : 0 } } }));
    const journal = new UpgradeJournal(path.join(root, 'journal')); let writes = 0;
    const deps = { journal, gate: new WorldWorkGate(), snapshot: async () => ({ world, targets: structuredClone(targets) }), assertAuthority: () => {},
        promote: async () => {}, restart: () => {}, prepare: async () => {}, activate: async () => {}, rollbackFiles: async () => {},
        write: async (target: MigrationTarget, updates: Record<string, unknown>, fence: () => void) => {
            fence(); writes++; targets.find(row => row.uuid === target.uuid)!.source = applyMigrationPatch(target.source, updates);
            if (writes === 2) throw new Error('lost second acknowledgement');
        } };
    const coordinator = new ModuleUpgradeCoordinator(deps); const preview = await coordinator.preview(candidate);
    assert.equal(preview.plan.blockers.length, 0); assert.deepEqual(preview.plan.operations.map(row => row.stepId), ['fix-b', 'fix-a']);
    const job = await coordinator.approve(candidate, { planId: preview.id, idempotencyKey: 'cumulative-approval', administrator: 'admin', backupAcknowledged: true });
    await assert.rejects(coordinator.resume(job.jobId, candidate), /uncertain/);
    await new ModuleUpgradeCoordinator(deps).resume(job.jobId, candidate);
    assert.equal(writes, 2, 'approved earlier transformations and a later unknown receipt reconcile without replay');
    assert.equal(journal.job(job.jobId).phase, 'completed');
};

cases['CR64-04'] = async () => {
    assert.equal(observeWorldRuntime(null), false, 'cold initial observation does not reload');
    assert.equal(observeWorldRuntime('first-upgrade'), true, 'CR64-04 null to first activation must retire an already observed browser');
    assert.notEqual(worldRuntimeHeaders()['X-SheetDelver-Runtime'], 'first-upgrade', 'old assets cannot adopt the replacement token before reload');
    assert.equal(observeWorldRuntime('first-upgrade'), false, 'one reload request per stale browser lifetime');
    for (const initial of [null, 'existing']) {
        const browser = new BrowserWorldRuntime();
        assert.equal(browser.observe(initial), false);
        assert.equal(browser.observe(initial), false);
        assert.equal(browser.observe('replacement'), true);
        assert.equal(browser.observe('replacement'), false);
        assert.notEqual(browser.headers()['X-SheetDelver-Runtime'], 'replacement');
    }
    const cold = new BrowserWorldRuntime(); assert.equal(cold.observe('replacement'), false);
    assert.equal(cold.headers()['X-SheetDelver-Runtime'], 'replacement', 'new assets accept their initial serving token');
};

cases['CR64-05'] = async root => {
    const { transport } = await host(root); let fail = false;
    const bootstrap = new WorldBootstrapper({
        getRegisteredModules: () => [{ ...fixture(path.join(root, 'candidate')).info, worldSettings: declarations }],
        loadAdapter: async () => ({ systemId: 'fixture', match: () => true, normalizeActorData: actor => ({ ...actor, id: actor._id, img: '', derived: {} }),
            onWorldContextChanged: async () => { if (fail) throw new Error('controlled refresh failure'); } }),
    });
    await bootstrap.bootstrap(transport);
    fail = true;
    await settingStore.seed(async () => [{ _id: 'setting', key: 'fixture.variant', value: 'true' }]);
    await assert.rejects(bootstrap.refreshWorldContext(), /controlled refresh failure/);
    worldWorkGate.block('unrelated', { phase: 'blocked', message: 'unrelated gate' });
    fail = false; await bootstrap.recover(transport);
    assert.equal(worldWorkGate.hasBlock('context-refresh'), false, 'CR64-05 successful recovery retires only its failed refresh latch');
    assert.equal(worldWorkGate.hasBlock('unrelated'), true);
};

cases['CR64-05-late-and-queued'] = async root => {
    const { source, transport } = await host(root);
    const changes: Array<{ keys: Array<{ key: string }> }> = [];
    moduleWorldContext.on('changed', event => changes.push(event));
    let complete: (() => void) | undefined; let hold = false; let calls = 0; let value = 'initial';
    const info = { ...fixture(path.join(root, 'candidate')).info, worldSettings: declarations };
    const bootstrap = new WorldBootstrapper({ getRegisteredModules: () => [info], loadAdapter: async () => ({
        systemId: 'fixture', match: () => true, normalizeActorData: actor => ({ ...actor, id: actor._id, img: '', derived: { value } }),
        onWorldContextChanged: async () => { calls++; if (hold) await new Promise<void>(resolve => { complete = resolve; }); value = hold ? 'late' : 'recovered'; },
    }) });
    await bootstrap.bootstrap(transport);
    hold = true; source.variant = true;
    await settingStore.seed(async () => [{ _id: 'setting', key: 'fixture.variant', value: 'true' }]);
    await assert.rejects(bootstrap.refreshWorldContext(), /timed out/);
    assert.equal(bootstrap.getContextRefreshDiagnostic()?.pendingHook, true);
    await assert.rejects(bootstrap.recover(transport), /still running/);
    assert.equal(calls, 1, 'no overlapping hook while timed-out code can still mutate its adapter');
    complete!(); await new Promise(resolve => setImmediate(resolve));
    hold = false;
    await bootstrap.bootstrap(transport); // ready shortcut must not swallow a failed refresh
    assert.equal(value, 'recovered'); assert.equal(bootstrap.getContextRefreshDiagnostic(), null);
    assert.equal(worldWorkGate.hasBlock('context-refresh'), false);

    hold = true;
    const recovering = bootstrap.recover(transport);
    while (calls < 3) await new Promise(resolve => setImmediate(resolve));
    source.variant = false;
    await settingStore.seed(async () => [{ _id: 'setting', key: 'fixture.variant', value: 'false' }]);
    await bootstrap.refreshWorldContext(); // records notification while recovery owns the hook
    complete!();
    await assert.rejects(recovering, /changed during recovery/);
    assert.equal(worldWorkGate.hasBlock('context-refresh'), true, 'older success cannot erase a queued newer notification');
    hold = false;
    await bootstrap.recover(transport);
    assert.equal(worldWorkGate.hasBlock('context-refresh'), false);
    assert.deepEqual(moduleWorldContext.snapshot().settings['fixture.variant'], { status: 'world', value: false });
    assert.ok(changes.at(-1)?.keys.some(row => row.key === 'fixture.variant'), 'successful queued recovery publishes its recovered setting revision');
    hold = true; source.variant = true;
    await settingStore.seed(async () => [{ _id: 'setting', key: 'fixture.variant', value: 'true' }]);
    await assert.rejects(bootstrap.refreshWorldContext(), /timed out/);
    const oldCalls = calls;
    bootstrap.reset('controlled-world-replacement');
    assert.ok(bootstrap.getContextRefreshDiagnostic()?.pendingHook, 'admin diagnosis survives retired context');
    await assert.rejects(bootstrap.bootstrap(transport), /still running/);
    assert.equal(calls, oldCalls, 'world replacement cannot reuse a cached adapter while its old hook is running');
    complete!(); await new Promise(resolve => setImmediate(resolve)); hold = false;
    await bootstrap.bootstrap(transport);
    assert.equal(worldWorkGate.hasBlock('context-refresh'), false);
};

cases['host-composition'] = async root => {
    const { source, transport } = await host(root);
    const nativeSource = fixture(path.join(root, 'author-source'));
    const directory = path.join(root, 'modules/fixture'); fs.mkdirSync(directory, { recursive: true });
    await packageMigrations(nativeSource.root, directory, nativeSource.info);
    fs.writeFileSync(path.join(directory, 'info.json'), JSON.stringify({ ...nativeSource.info, worldSettings: declarations }));
    fs.writeFileSync(path.join(directory, 'logic.js'), `export class Adapter { systemId='fixture'; match(){return true} prepareActorData(actor,context){return {...actor,id:actor._id,img:'',derived:{fixed:actor.system.fixed,variant:context.world.settings['fixture.variant']}}} normalizeActorData(actor){return {...actor,id:actor._id,img:'',derived:{}}} }`);
    fs.writeFileSync(path.join(directory, 'ui.js'), 'export default {}');
    refreshRegistry(); enableModule('fixture');
    const bootstrap = new WorldBootstrapper();
    source.fixed = false;
    await assert.rejects(bootstrap.bootstrap(transport), /maintenance/);
    assert.equal(bootstrap.getActiveAdapter(), null, 'installed checks run before adapter construction');
    assert.ok(getMigrationCompatibilityDiagnostic()?.blockers.length);
    source.variant = true; // native setting changed without a serving-context refresh
    const preview = await previewModuleSource('fixture', 'managed');
    assert.deepEqual(moduleWorldContext.snapshot().settings['fixture.variant'], { status: 'world', value: false }, 'preview does not consume the pending setting change');
    const job = await applyModuleSource(preview.id, 'test-admin', true);
    assert.equal(job.phase, 'restarting');
    assert.equal(source.writes.length, 0);
    await bootstrap.bootstrap(transport); // real installed compatibility resumes real host coordinator
    assert.equal((await getUpgradeJournal().job(job.jobId)).phase, 'completed');
    assert.deepEqual(source.writes, ['a']);
    assert.equal((preparedActorStore.getRequired('a').derived as any).fixed, true, 'preparation uses migrated serving sources, not a stale preview/Store split');
    assert.deepEqual((preparedActorStore.getRequired('a').derived as any).variant, { status: 'world', value: true }, 'prepared context matches the approved native setting');
    assert.equal(worldWorkGate.isOpen(), true);
    // Completed history does not authorize a repair after an external restore.
    source.fixed = false;
    await assert.rejects(bootstrap.recover(transport), /maintenance/);
    assert.deepEqual(source.writes, ['a']);
    const repair = await previewModuleSource('fixture', 'managed');
    assert.deepEqual(repair.stepDigests, job.stepDigests, 'same-version managed repair retains historical identities');
    await applyModuleSource(repair.id, 'test-admin', true);
    await bootstrap.bootstrap(transport);
    assert.deepEqual(source.writes, ['a', 'a']);
    const catalog = discoverMigrations(directory, nativeSource.info)!;
    const hookFile = path.join(directory, catalog.steps[0].entries.check.path);
    const hook = fs.readFileSync(hookFile, 'utf8');
    fs.writeFileSync(hookFile, `${hook}\n// genuine packaged code change\n`);
    await assert.rejects(previewModuleSource('fixture', 'managed'), /Historical migration step/, 'real code changes still require a new stable step ID');
    fs.writeFileSync(hookFile, hook);
    source.fail = 'Actor';
    await assert.rejects(checkInstalledWorldCompatibility('fixture'));
    assert.equal(getMigrationCompatibilityDiagnostic()?.phase, 'source-check');
    source.fail = '';
    await assert.rejects(checkInstalledWorldCompatibility('fixture', async () => { throw new Error('Controlled preparation failure'); }));
    assert.equal(getMigrationCompatibilityDiagnostic()?.phase, 'preparation');
    const definitionFile = path.join(directory, 'migrations/1.0.0/definition.json');
    const definition = fs.readFileSync(definitionFile, 'utf8');
    const incompatible = JSON.parse(definition); incompatible.dataReadVersion = '>=2.0.0 <3.0.0';
    fs.writeFileSync(definitionFile, JSON.stringify(incompatible));
    await assert.rejects(checkInstalledWorldCompatibility('fixture'));
    assert.ok(getMigrationCompatibilityDiagnostic(), 'unsupported source versions also remain diagnosable');
    fs.writeFileSync(definitionFile, definition);
    // Discovery failures also have bounded admin-only diagnostics.
    fs.writeFileSync(path.join(directory, 'migration.json'), '{}');
    await assert.rejects(checkInstalledWorldCompatibility('fixture'));
    assert.equal(getMigrationCompatibilityDiagnostic()?.phase, 'discovery');

    await createAdminAccount('isolated-composition-password');
    const app = express(); app.use(express.json());
    // Real network/origin/account/auth/CSRF/audit and upgrade route composition.
    // The unrelated status facade/broadcast are not needed by these requests.
    app.use(createAdminRouter({ getSystemStatusPayload: async () => ({}), broadcastToClients: () => {} }));
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}`;
    const claims = createAdminSessionClaims('test-admin', 60_000); const token = adminSessionManager.storeSession(claims);
    const headers = { Authorization: `Bearer ${token}`, Origin: 'http://127.0.0.1:31990', 'Content-Type': 'application/json' };
    try {
        assert.equal((await fetch(`${url}/module-upgrades`)).status, 401);
        const status = await fetch(`${url}/module-upgrades`, { headers }); assert.equal(status.status, 200);
        assert.equal((await status.json()).compatibilityDiagnostic.phase, 'discovery');
        assert.equal((await fetch(`${url}/module-upgrades/retry-context`, { method: 'POST', headers })).status, 403);
        const checked = await fetch(`${url}/module-upgrades/source/fixture/preview`, { method: 'POST', headers: { ...headers, 'X-Admin-Csrf-Token': claims.csrfToken }, body: '{"source":"managed"}' });
        assert.equal(checked.status, 409, 'actual source route rejects malformed catalog without granting approval');
        adminSessionManager.revokeSession(token);
        assert.equal((await fetch(`${url}/module-upgrades`, { headers })).status, 401);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
};

export async function run(): Promise<void> {
    for (const id of Object.keys(cases)) {
        const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--case', id], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });
        assert.equal(result.status, 0, `${id}: ${result.stdout}\n${result.stderr}`);
    }
    console.log(`ADR-0064 corrective regressions: CR64-01–06 passed (${Object.keys(cases).length} cases)`);
}
if (import.meta.url === `file://${process.argv[1]}`) {
    const id = process.argv[process.argv.indexOf('--case') + 1];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-cr64-correctness-'));
    (cases[id] ? cases[id](root) : run()).then(() => console.log(`${id || 'all'}: correctness PASS`)).catch(error => { console.error(error); process.exitCode = 1; })
        .finally(() => fs.rmSync(root, { recursive: true, force: true }));
}
