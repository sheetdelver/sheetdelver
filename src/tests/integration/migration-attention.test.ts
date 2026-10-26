import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { migrationAttentionHost } from '../fixtures/migrationAttentionHost';
import { previewModuleSource } from '@server/services/world/migrations/sourceCandidates';
import { readAdminMigrationOverview, exactMigrationStatus } from '@server/services/world/migrations/migrationAttention';
import { getUpgradeJournal, createHostUpgradeCoordinator } from '@server/services/world/migrations/ModuleUpgradeService';
import { checkInstalledWorldCompatibility } from '@server/services/world/migrations/installedWorldCompatibility';
import { createAdminRouter } from '@server/routes/admin/createAdminRouter';
import { createAdminAccount } from '@server/security/adminCredentialStore';
import { adminSessionManager, createAdminSessionClaims } from '@server/security/adminSessionService';
import { moduleWorldContext } from '@server/services/world/ModuleWorldContextService';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { compendiumStore } from '@server/core/compendium/CompendiumStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { serviceAccountAuthority } from '@server/core/world/ServiceAccountAuthority';
import { saveMaintenanceMode } from '@server/core/world/MaintenanceMode';
import { worldWorkGate } from '@server/core/world/WorldWorkGate';
import { switchModuleSource } from '@modules/registry/server';
import { ModuleSourceCategory } from '@shared/types/modules';
import type { UpgradeJob } from '@server/services/world/migrations/UpgradeJournal';
import { warmMaintenanceMigrationStatus, maintenanceMigrationStatus } from '@server/services/world/migrations/migrationAttention';
import { initDataDir } from '@server/core/paths';

const cases: Record<string, (root: string) => Promise<void>> = {};
const sourceStatus = (source: 'local' | 'managed' = 'local') => readAdminMigrationOverview().sources.find(row => row.moduleId === 'fixture' && row.source === source)!;
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 30));

cases['required-empty-history-inactive-zero'] = async root => {
    const { source } = await migrationAttentionHost(root); source.fixed = false; actorStore.observeMutation();
    assert.equal(sourceStatus().state, 'unknown'); assert.equal(sourceStatus('managed').state, 'unknown');
    const preview = await previewModuleSource('fixture', 'local'); assert.equal(preview.plan.operations.length, 1);
    const active = readAdminMigrationOverview().active!; assert.equal(active.source, 'local'); assert.equal(active.state, 'required');
    assert.equal(active.proposedWrites, 1); assert.equal(active.world?.worldId, 'w1'); assert.equal(active.version, '1.0.0');
    assert.equal((await getUpgradeJournal().jobs()).length, 0, 'required changes cannot be hidden by empty history');
    assert.equal(sourceStatus('managed').state, 'unknown', 'inactive source cannot inherit active evidence');
    const zero = await previewModuleSource('fixture', 'managed'); assert.equal(zero.plan.operations.length, 0);
    assert.equal(sourceStatus('managed').state, 'up-to-date'); assert.equal(sourceStatus('managed').selectedSource, false);
    assert.equal(sourceStatus('managed').version, '2.0.0'); assert.equal(sourceStatus().state, 'required');
    const reads = source.reads.length; for (let i = 0; i < 25; i++) readAdminMigrationOverview();
    assert.equal(source.reads.length, reads, 'polling cannot run full migration/source scans'); assert.deepEqual(source.writes, []);
    assert(switchModuleSource('fixture', ModuleSourceCategory.Managed, () => {}).success);
    const reversed = readAdminMigrationOverview(); assert.equal(reversed.active?.source, 'managed'); assert.equal(reversed.active?.state, 'up-to-date');
    assert.equal(sourceStatus().selectedSource, false); assert.equal(sourceStatus().state, 'required');
};
cases['bootstrap-checking-current-and-required'] = async root => {
    const { source } = await migrationAttentionHost(root); let checking = false;
    source.onRead = type => { if (type === 'Actor') checking ||= sourceStatus().state === 'checking'; };
    await checkInstalledWorldCompatibility('fixture'); assert(checking); assert.equal(sourceStatus().state, 'up-to-date');
    assert(sourceStatus().checkedAt); assert(sourceStatus().catalogDigest);
    const checkedAt = sourceStatus().checkedAt;
    settingStore.upsert({ _id: 'clock', key: 'core.time', value: '1' });
    settingStore.patch('clock', { value: '2' });
    assert.equal(sourceStatus().state, 'up-to-date', 'unrelated setting churn must not retire migration evidence');
    assert.equal(sourceStatus().checkedAt, checkedAt, 'background clocks do not rerun or invent compatibility checks');
    settingStore.upsert({ _id: 'permissions', key: 'core.permissions', value: '{}' });
    assert.equal(sourceStatus().state, 'unknown', 'permission changes still retire migration evidence');
    await checkInstalledWorldCompatibility('fixture'); assert.equal(sourceStatus().state, 'up-to-date');
    source.fixed = false; actorStore.observeMutation();
    await assert.rejects(checkInstalledWorldCompatibility('fixture')); assert.equal(sourceStatus().state, 'required');
    assert.equal(sourceStatus().proposedWrites, undefined, 'check-only evidence must not invent a proposed-write count');
};
cases['catalog-absence-and-check-failure'] = async root => {
    const { local } = await migrationAttentionHost(root);
    fs.unlinkSync(path.join(local.root, 'migration.json')); await turn();
    assert.equal(sourceStatus().state, 'no-migrations'); assert.match(sourceStatus().reason, /not validation/);
    fs.writeFileSync(path.join(local.root, 'migration.json'), '{}'); await turn();
    assert.equal(sourceStatus().state, 'unknown', 'catalog presence alone establishes nothing');
    await assert.rejects(previewModuleSource('fixture', 'local'));
    assert.equal(sourceStatus().state, 'blocked'); assert.notEqual(sourceStatus().state, 'required');
};
cases['local-input-status-observation'] = async root => {
    const { local } = await migrationAttentionHost(root);
    fs.mkdirSync(path.join(local.root, 'working'));
    fs.writeFileSync(path.join(local.root, 'working', 'helper.js'), 'export const value=1;');
    fs.appendFileSync(path.join(local.root, 'logic.js'), '\nimport {value} from "./working/helper"; export const inspected=value;');
    await previewModuleSource('fixture', 'local');
    const checked = sourceStatus();
    assert.equal(checked.state, 'up-to-date');
    fs.writeFileSync(path.join(local.root, 'working', 'notes.txt'), 'unrelated adjacent file');
    await turn();
    assert.equal(sourceStatus().scopeKey, checked.scopeKey);
    assert.equal(sourceStatus().state, 'up-to-date');
    fs.writeFileSync(path.join(local.root, 'working', 'helper.ts'), 'export const value=2;');
    await turn();
    assert.equal(sourceStatus().state, 'unknown', 'new higher-priority import resolution retires the prior check');
    await previewModuleSource('fixture', 'local');
    assert.equal(sourceStatus().state, 'up-to-date');
    fs.appendFileSync(path.join(local.root, 'working', 'helper.ts'), '\n// changed imported helper');
    await turn();
    assert.equal(sourceStatus().state, 'unknown');
    await previewModuleSource('fixture', 'local');
    fs.mkdirSync(path.join(local.root, 'assets'));
    fs.writeFileSync(path.join(local.root, 'assets', 'icon.svg'), '<svg/>');
    await turn();
    assert.equal(sourceStatus().state, 'unknown', 'new declared resource scope retires the prior check');
};
cases['source-context-pack-user-revisions'] = async root => {
    const { source, local } = await migrationAttentionHost(root); await previewModuleSource('fixture', 'local');
    let key = sourceStatus().scopeKey;
    moduleWorldContext.touchDependencies(); assert.equal(sourceStatus().state, 'unknown'); assert.throws(() => exactMigrationStatus('fixture', 'local', key), /stale/);
    await previewModuleSource('fixture', 'local'); actorStore.observeMutation(); assert.equal(sourceStatus().state, 'unknown');
    await previewModuleSource('fixture', 'local'); userStore.observeMutation(); assert.equal(sourceStatus().state, 'unknown');
    compendiumStore.seedPackMetadataFromGameData({ packs: [{ id: 'world.arbitrary', type: 'Actor' }] } as never);
    await previewModuleSource('fixture', 'local'); await compendiumStore.invalidatePackContent(null, 'world.arbitrary');
    assert.equal(sourceStatus().state, 'unknown');
    await previewModuleSource('fixture', 'local'); key = sourceStatus().scopeKey;
    fs.appendFileSync(path.join(local.root, 'logic.js'), '\n// changed source artifact\n'); await turn();
    assert.equal(sourceStatus().state, 'unknown'); assert.throws(() => exactMigrationStatus('fixture', 'local', key), /stale/);
    assert.deepEqual(source.writes, []);
};
cases['offline-reconnect-world-switch'] = async root => {
    const { transport, data } = await migrationAttentionHost(root); await previewModuleSource('fixture', 'local');
    (transport as any).isSocketConnected = false;
    assert.equal(sourceStatus().state, 'unavailable'); (transport as any).isSocketConnected = true;
    Object.defineProperty(transport, 'connectionEpoch', { value: transport.connectionEpoch + 1, configurable: true });
    assert.equal(sourceStatus().state, 'unknown', 'old success must not revive after reconnect');
    await previewModuleSource('fixture', 'local');
    worldStateStore.seed({ ...data, world: { id: 'w2', title: 'Other vault' } } as never);
    assert.equal(sourceStatus().state, 'unavailable', 'a newly observed world cannot borrow the previous prepared context');
    assert.equal(sourceStatus().world?.worldId, 'w2'); assert.equal(sourceStatus().world?.title, 'Other vault');
    moduleWorldContext.configure('http://offline.invalid:30000', { ...moduleWorldContext.snapshot().identity, worldId: 'w2' });
    assert.equal(sourceStatus().state, 'unknown'); assert.equal(sourceStatus().world?.worldId, 'w2');
    serviceAccountAuthority.retire(); assert.equal(sourceStatus().state, 'unavailable');
};
cases['historical-completion-not-readiness'] = async root => {
    const { local, source } = await migrationAttentionHost(root);
    const preview = await previewModuleSource('fixture', 'local');
    const job: UpgradeJob = { ...preview, jobId: 'historical-completed', phase: 'completed', administrator: 'prior-admin', idempotencyKey: 'historical-completion',
        backupAcknowledged: true, backupWarningRevision: 1, leaseToken: 'historical-lease', candidateRoot: local.root, sourceCategory: 'local', sourceDirectory: local.root, possibleWrite: true, outcomes: {}, completedAt: Date.now(), worldDataStatus: 'verified' };
    await getUpgradeJournal().save(job); source.fixed = false; actorStore.observeMutation();
    assert.equal(sourceStatus().state, 'unknown');
    await previewModuleSource('fixture', 'local'); assert.equal(sourceStatus().state, 'required');
};
cases['expired-evidence-and-async-retirement'] = async root => {
    const { source } = await migrationAttentionHost(root);
    const preview = await previewModuleSource('fixture', 'local'); assert.equal(sourceStatus().state, 'up-to-date');
    const now = Date.now;
    try { Date.now = () => preview.expiresAt + 1; assert.equal(sourceStatus().state, 'unknown'); assert.equal(sourceStatus().previewId, undefined); }
    finally { Date.now = now; }
    source.onRead = type => { if (type === 'Actor') actorStore.observeMutation(); };
    await assert.rejects(previewModuleSource('fixture', 'local'));
    assert.notEqual(sourceStatus().state, 'up-to-date', 'late checks cannot restore green after a source revision');
    assert.deepEqual(source.writes, []);
};
cases['durable-maintenance-recovery-precedence'] = async root => {
    const { source } = await migrationAttentionHost(root); await previewModuleSource('fixture', 'local'); assert.equal(sourceStatus().state, 'up-to-date');
    const preview = await previewModuleSource('fixture', 'managed'); const candidate = await getUpgradeJournal().sourceCandidate(preview.id);
    const id = 'managed-recovery';
    const job: UpgradeJob = { ...preview, jobId: id, phase: 'recovery-required', administrator: 'prior-admin', idempotencyKey: 'managed-recovery-key',
        backupAcknowledged: true, backupWarningRevision: 1, leaseToken: 'retained-lease', candidateRoot: candidate.root,
        sourceCategory: 'managed', sourceDirectory: candidate.sourceDirectory, possibleWrite: true, outcomes: {}, failure: 'Controlled uncertain native acknowledgement' };
    await getUpgradeJournal().save(job);
    assert.equal(readAdminMigrationOverview().maintenance?.state, 'recovery-required', 'pending durable job supersedes old green even before mode is restored');
    saveMaintenanceMode({ schemaVersion: 1, id, moduleId: 'fixture', candidateId: preview.id, previewId: preview.id, jobId: id,
        stage: 'recovery-required', drained: true, world: preview.plan.world.identity, failure: job.failure, updatedAt: Date.now() });
    const reads = source.reads.length;
    const overview = readAdminMigrationOverview(); assert.deepEqual(overview.sources, []);
    assert.equal(overview.maintenance?.source, 'managed'); assert.equal(overview.maintenance?.version, '2.0.0');
    assert.equal(overview.maintenance?.state, 'recovery-required'); assert.match(overview.maintenance!.reason, /uncertain/);
    assert.equal(source.reads.length, reads); assert.deepEqual(source.writes, []);
    saveMaintenanceMode({ schemaVersion: 1, id, moduleId: 'fixture', candidateId: preview.id, previewId: preview.id,
        stage: 'review', drained: true, world: preview.plan.world.identity, updatedAt: Date.now() });
    const review = readAdminMigrationOverview().maintenance!; assert.equal(review.state, 'in-progress'); assert.equal(review.proposedWrites, 0); assert.match(review.nextStep!, /acknowledge/);
    const cold = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--cold-maintenance', root], { encoding: 'utf8', timeout: 30000 });
    assert.equal(cold.status, 0, cold.stdout + cold.stderr);
    saveMaintenanceMode({ schemaVersion: 1, id, moduleId: 'fixture', stage: 'activating', drained: true, updatedAt: Date.now() });
    assert.equal(readAdminMigrationOverview().maintenance?.state, 'in-progress', 'completion is not final activation');
};
cases['http-authorization-exact-review-and-retirement'] = async root => {
    const { source, local } = await migrationAttentionHost(root); source.fixed = false; actorStore.observeMutation();
    // CR64-29: the public Check world data path must tolerate arbitrary local
    // output, without relying on a special folder name or .gitignore.
    fs.mkdirSync(path.join(local.root, 'work-output'));
    const oversized = fs.openSync(path.join(local.root, 'work-output', 'build.bin'), 'w');
    try { fs.ftruncateSync(oversized, 600 * 1024 * 1024); } finally { fs.closeSync(oversized); }
    await createAdminAccount('isolated-attention-fixture');
    const app = express(); app.use(express.json()); app.use(createAdminRouter({ getSystemStatusPayload: async () => ({}), broadcastToClients: () => {} }));
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const claims = createAdminSessionClaims('attention-admin', 60000); const token = adminSessionManager.storeSession(claims);
    const headers = { Authorization: `Bearer ${token}`, Origin: 'http://127.0.0.1:31990', 'Content-Type': 'application/json', 'X-Admin-Csrf-Token': claims.csrfToken };
    try {
        assert.equal((await fetch(base + '/module-migrations')).status, 401);
        assert.equal((await fetch(base + '/module-migrations', { headers: { Authorization: 'Bearer player-session' } })).status, 401);
        const before = await fetch(base + '/module-migrations', { headers }); assert.equal(before.status, 200); assert.equal(before.headers.get('cache-control'), 'no-store');
        const status = (await before.json()).active;
        const checked = await fetch(base + '/module-upgrades/source/fixture/preview', { method: 'POST', headers, body: JSON.stringify({ source: 'local', scopeKey: status.scopeKey }) });
        assert.equal(checked.status, 200); const preview = await checked.json(); assert.equal(preview.plan.operations.length, 1);
        assert.equal(sourceStatus().state, 'required');
        fs.writeFileSync(path.join(local.root, 'work-output', 'notes.txt'), 'unrelated output');
        fs.writeFileSync(path.join(local.root, 'unused.ts'), 'export const unrelated=true;');
        await turn();
        assert.equal(sourceStatus().state, 'required', 'unrelated workspace changes do not retire a current migration status');
        assert.equal(sourceStatus().scopeKey, status.scopeKey, 'unrelated files do not change exact-source navigation');
        const query = new URLSearchParams({ source: 'local', scopeKey: status.scopeKey }); const reads = source.reads.length;
        const review = await fetch(base + '/module-upgrades/source/fixture/review?' + query, { headers }); assert.equal(review.status, 200);
        assert.equal((await review.json()).id, preview.id); assert.equal(source.reads.length, reads, 'opening a notice/review must not rerun scans');
        actorStore.observeMutation();
        assert.equal((await fetch(base + '/module-upgrades/source/fixture/review?' + query, { headers })).status, 409);
        assert.equal((await fetch(base + '/module-upgrades/source/fixture/preview', { method: 'POST', headers, body: JSON.stringify({ source: 'managed', scopeKey: status.scopeKey }) })).status, 409, 'inactive source cannot borrow active approval identity');
        assert.deepEqual(source.writes, []); assert.equal((await getUpgradeJournal().jobs()).length, 0);
        await previewModuleSource('fixture', 'local');
        const freshScope = sourceStatus().scopeKey;
        const journal = getUpgradeJournal(), originalRead = journal.preview.bind(journal);
        let opened!: () => void, release!: () => void;
        const entered = new Promise<void>(resolve => { opened = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
        journal.preview = async id => { const value = await originalRead(id); opened(); await barrier; return value; };
        const late = fetch(base + '/module-upgrades/source/fixture/review?' + new URLSearchParams({ source: 'local', scopeKey: freshScope }), { headers });
        await entered; adminSessionManager.revokeSession(token); release();
        assert.equal((await late).status, 401, 'retired administrator cannot receive a late private plan'); journal.preview = originalRead;
        assert.equal((await fetch(base + '/module-migrations', { headers })).status, 401);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
};
export async function run() {
    for (const id of Object.keys(cases)) {
        const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--case', id], { cwd: process.cwd(), encoding: 'utf8', timeout: 60000 });
        assert.equal(result.status, 0, `${id}: ${result.stdout}\n${result.stderr}`);
    }
    console.log(`CR64-22 migration attention: ${Object.keys(cases).length} Core/HTTP state and identity cases passed`);
}
if (import.meta.url === `file://${process.argv[1]}`) {
    if (process.argv.includes('--cold-maintenance')) {
        initDataDir(process.argv[process.argv.indexOf('--cold-maintenance') + 1]);
        void warmMaintenanceMigrationStatus().then(() => {
            const current = maintenanceMigrationStatus()!;
            assert.equal(current.source, 'managed'); assert.equal(current.version, '2.0.0'); assert.equal(current.world?.worldId, 'w1');
            assert.equal(current.proposedWrites, 0); assert.equal(current.state, 'in-progress');
            console.log('Cold offline maintenance identity restored from durable journal without native transport');
        }).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => getUpgradeJournal().close());
    } else {
    const id = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : '';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-cr64-22-status-'));
    (id ? cases[id](root) : run()).catch(error => { console.error(error); process.exitCode = 1; })
        .finally(async () => { if (id) await getUpgradeJournal().close(); fs.rmSync(root, { recursive: true, force: true }); });
    }
}
