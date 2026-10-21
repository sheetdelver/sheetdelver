import { createHook } from 'node:async_hooks';
import { checkInstalledWorldCompatibility } from '@server/services/world/migrations/installedWorldCompatibility';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { host } from './adr0064-corrections.test';
import { fixture, world } from '../unit/world/module-world-migrations.test';
import { packIsWritableWorld, migrationEnvelope, enumerateMigrationTargets, type MigrationSourceView } from '@server/services/world/migrations/targets';
import { freshMigrationSnapshot } from '@server/services/world/migrations/ModuleUpgradeService';
import { discoverMigrations } from '@modules/registry/migrations/catalog';
import { compendiumStore } from '@server/core/compendium/CompendiumStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { moduleWorldContext } from '@server/services/world/ModuleWorldContextService';
import { worldBootstrapper } from '@server/services/world/WorldBootstrapper';
import { refreshRegistry, enableModule } from '@modules/registry/server';
import { SdkError, isSdkError, SDK_ERROR_STATUS } from '@shared/sdk/errors';
import express from 'express';
import * as tar from 'tar';
import { build } from 'esbuild';
import { createModuleRouter } from '@server/routes/modules/createModuleRouter';
import { packageMigrations } from '@modules/registry/migrations/compile';
import { computeWorldMigrations } from '@server/services/world/migrations/compute';
import { getOrphanTokenCleanup } from '@server/services/world/OrphanTokenCleanup';
import { sceneStore } from '@server/core/documents/primary/scenes/SceneStore';

const cases: Record<string, (root: string) => Promise<void>> = {};
for (const generation of [13, 14]) cases[`orphans-v${generation}`] = async root => {
    const { transport, source, data } = await host(root); data.release.generation = generation;
    const candidate = fixture(path.join(root, 'modules/fixture'));
    fs.writeFileSync(path.join(candidate.root, 'logic.js'), 'export class Adapter {systemId="fixture";match(){return true} normalizeActorData(a){return {...a,id:a._id,img:"",derived:{}}}}');
    fs.writeFileSync(path.join(candidate.root, 'ui.js'), 'export default {}');
    const file = path.join(candidate.root, 'migrations/1.0.0/definition.json');
    const definition = JSON.parse(fs.readFileSync(file, 'utf8')); definition.steps[0].targets = ['ActorDelta'];
    fs.writeFileSync(file, JSON.stringify(definition)); refreshRegistry();
    const scene = { _id: 'chapel', name: 'Old chapel', tokens: [{ _id: 'orphan', name: 'Skeleton', actorId: 'gone', actorLink: false,
        delta: { _id: 'delta', system: { fixed: false }, items: [{ _id: 'old-item' }], effects: [{ _id: 'legacy-effect', changes: [] }] } }] };
    const originalScene = structuredClone(scene); let restored = false; let deletes = 0;
    const original = transport.emitSocketEvent.bind(transport);
    transport.emitSocketEvent = async <T>(event: string, ...payloads: any[]): Promise<T> => {
        const { type, action, operation } = payloads[0];
        if (type === 'Scene' && action === 'get') return { type, action, operation, result: [structuredClone(scene)] } as T;
        if (type === 'Actor' && action === 'get' && restored) return { type, action, operation, result: [{ _id: 'a', system: { fixed: true } }, { _id: 'gone', system: { fixed: true } }] } as T;
        if (type === 'Token' && action === 'delete') {
            assert.equal(operation.parentUuid, 'Scene.chapel'); assert.deepEqual(operation.ids, ['orphan']);
            deletes++; scene.tokens = []; return { type, action, operation, result: ['orphan'] } as T;
        }
        return original<T>(event, ...payloads);
    };
    await worldBootstrapper.bootstrap(transport);
    assert.equal(worldBootstrapper.isReady(), true, 'an inert orphan does not block adapter preparation');
    assert.deepEqual(scene, originalScene, 'startup preserves all token/Item/effect source'); assert.deepEqual(source.writes, []);
    const catalog = discoverMigrations(candidate.root, candidate.info)!;
    const orphanSnapshot = await freshMigrationSnapshot(catalog);
    assert.equal(orphanSnapshot.targets.length, 0); assert.equal(orphanSnapshot.exclusions?.length, 1);
    restored = true;
    const restoredSnapshot = await freshMigrationSnapshot(catalog);
    assert.equal(restoredSnapshot.targets.filter(row => row.kind === 'ActorDelta').length, 1, 'restored Actor makes persisted delta eligible');
    assert.equal((await computeWorldMigrations(candidate.root, catalog, restoredSnapshot.world, restoredSnapshot.targets, true)).blockers.length, 1);
    restored = false;
    const cleanup = await getOrphanTokenCleanup(); const review = cleanup.list()[0];
    assert.equal(review.tokenName, 'Skeleton'); assert.equal(deletes, 0);
    await cleanup.remove({ ...review, confirmed: true }, () => {});
    assert.equal(deletes, 1); assert.equal(sceneStore.getToken('chapel', 'orphan'), null, 'normal confirmation ingress updates primary SceneStore');
    assert.deepEqual(cleanup.list(), []);
    worldBootstrapper.reset('orphan-regression-complete');
};
cases['compatibility-reuse'] = async root => {
    const { source } = await host(root);
    const candidate = fixture(path.join(root, 'modules/fixture'));
    fs.writeFileSync(path.join(candidate.root, 'logic.js'), 'export class Adapter {systemId="fixture";match(){return true}}');
    fs.writeFileSync(path.join(candidate.root, 'ui.js'), 'export default {}');
    refreshRegistry(); enableModule('fixture');
    let workers = 0;
    const observer = createHook({ init(_id, type) { if (type === 'WORKER') workers++; } }).enable();
    try {
        await checkInstalledWorldCompatibility('fixture');
        assert.ok(workers >= 1); const firstWorkers = workers;
        const reads = source.reads.length;
        await checkInstalledWorldCompatibility('fixture');
        assert.equal(workers, firstWorkers, 'unchanged installed checks reuse disk result without any new computation worker');
        assert.ok(source.reads.length > reads, 'fresh native source comparison still detects outside restores');
        source.fixed = false;
        await assert.rejects(checkInstalledWorldCompatibility('fixture'), /requires admin maintenance/);
        assert.equal(workers, firstWorkers + 1, 'restored legacy source triggers checks and blocks without auto-repair');
        assert.deepEqual(source.writes, []);
    } finally { observer.disable(); }
};
cases.locks = async root => {
    const { transport, source } = await host(root);
    source.fixed = false;
    const candidate = fixture(path.join(root, 'candidate'));
    const file = path.join(candidate.root, 'migrations/1.0.0/definition.json');
    const definition = JSON.parse(fs.readFileSync(file, 'utf8')); definition.steps[0].targets = ['WorldPack'];
    fs.writeFileSync(file, JSON.stringify(definition));
    const pack = 'world.unusualActors';
    const metadata = { id: pack, type: 'Actor', packageType: 'world' };
    compendiumStore.seedPackMetadataFromGameData({ system: { id: 'fixture' }, packs: [metadata],
        world: { packs: [{ name: 'unusualActors', type: 'Actor' }] } });
    assert.equal(compendiumStore.getPackMetadata('fixture.unusualActors'), null, 'world manifest cannot create a phantom system-scoped pack');
    const original = transport.emitSocketEvent.bind(transport);
    transport.emitSocketEvent = async <T>(event: string, ...payloads: any[]): Promise<T> => payloads[0].type === 'Setting'
        ? { result: settingStore.list() } as T : original<T>(event, ...payloads);
    compendiumStore.setPackMetadata(pack, metadata);
    assert.equal(packIsWritableWorld(pack), true, 'native world packs without lock configuration are unlocked');
    const catalog = discoverMigrations(candidate.root, candidate.info)!;
    const snapshot = await freshMigrationSnapshot(catalog);
    assert.equal(snapshot.targets.length, 1, 'required absent-lock pack is completely enumerated');
    const target = snapshot.targets[0]; assert.equal(target.pack, pack);
    for (const [configured, expected] of [[true, false], [false, true], [null, true]] as const) {
        await settingStore.seed(async () => [{ _id: 'config', key: 'core.compendiumConfiguration', value: JSON.stringify({ [pack]: { locked: configured } }) }]);
        compendiumStore.setPackMetadata(pack, { ...metadata, locked: true });
        assert.equal(packIsWritableWorld(pack), expected, 'native configuration/default takes precedence, never metadata.locked');
    }
    await settingStore.seed(async () => [{ _id: 'config', key: 'core.compendiumConfiguration', value: JSON.stringify({ [pack]: { locked: true } }) }]);
    assert.throws(snapshot.assertCurrent, /scope changed/);
    assert.throws(() => migrationEnvelope(target, { 'system.fixed': true }), /locked/);
    const locked = await freshMigrationSnapshot(catalog);
    assert.equal(locked.targets.length, 1, 'locked pack is readable and still fully checked');
    const lockedPlan = await computeWorldMigrations(candidate.root, catalog, locked.world, locked.targets);
    assert.equal(lockedPlan.operations.length, 0);
    assert.match(lockedPlan.blockers[0], /world.unusualActors.*needs changes but is locked/);
    const currentLocked = structuredClone(locked.targets);
    currentLocked[0].source.system = { fixed: true };
    for (const checkOnly of [false, true]) {
        const currentPlan = await computeWorldMigrations(candidate.root, catalog, locked.world, currentLocked, checkOnly);
        assert.equal(currentPlan.checked, 1); assert.deepEqual(currentPlan.blockers, []); assert.deepEqual(currentPlan.operations, []);
    }
    await settingStore.seed(async () => []);
    const unlocked = await freshMigrationSnapshot(catalog);
    const unlockedPlan = await computeWorldMigrations(candidate.root, catalog, unlocked.world, unlocked.targets);
    assert.equal(unlockedPlan.operations.length, 1, 'unlock permits reviewed migration without bypassing the check');
    assert.notEqual(unlockedPlan.inventoryHash, lockedPlan.inventoryHash, 'lock changes retire prior approval identity');
    for (const packageType of ['system', 'module', undefined]) {
        compendiumStore.setPackMetadata(pack, { ...metadata, packageType, locked: false });
        await settingStore.seed(async () => [{ _id: 'config', key: 'core.compendiumConfiguration', value: JSON.stringify({ [pack]: { locked: false } }) }]);
        assert.equal(packIsWritableWorld(pack), false, 'prefix/unlock never proves world ownership');
        if (packageType === undefined) await assert.rejects(freshMigrationSnapshot(catalog), /ownership is unavailable/, 'required migration cannot silently exclude unresolved ownership');
    }
    compendiumStore.setPackMetadata(pack, metadata);
    await settingStore.seed(async () => [{ _id: 'bad', key: 'core.compendiumConfiguration', value: 'unreadable' }]);
    assert.equal(packIsWritableWorld(pack), false, 'malformed configuration is not verified absence');
    await settingStore.seed(async () => [{ _id: 'bad', key: 'core.compendiumConfiguration' } as never]);
    assert.equal(packIsWritableWorld(pack), false, 'present missing-value configuration is unreadable, not absent');
    const unavailableLock = await freshMigrationSnapshot(catalog);
    const unavailablePlan = await computeWorldMigrations(candidate.root, catalog, unavailableLock.world, unavailableLock.targets);
    assert.match(unavailablePlan.blockers[0], /lock setting is unavailable/);
    const view: MigrationSourceView = { actors: [], items: [], scenes: [], packs: [metadata], configuration: {}, subject: { userId: 'service', role: 4 }, generation: 14 };
    for (const response of [null, { result: [null] }, { result: [{ _id: 'invalid.identity' }] }, new Error('read failed')]) {
        const wire = { dispatchDocumentSocket: async () => { if (response instanceof Error) throw response; return response; } };
        await assert.rejects(enumerateMigrationTargets(wire, new Set(['WorldPack']), [], { view }), /Required pack enumeration unavailable/);
        const exclusions: string[] = [];
        assert.deepEqual(await enumerateMigrationTargets(wire, new Set(['WorldPack']), [], { view, requiredKinds: new Set(), exclusions }), []);
        assert.equal(exclusions.length, 1, 'declared advisory pack failure is reported without becoming a required blocker');
        await assert.rejects(enumerateMigrationTargets(wire, new Set(), [pack], { view }), /Required pack enumeration unavailable/);
        const referenceExclusions: string[] = [];
        assert.deepEqual(await enumerateMigrationTargets(wire, new Set(), [pack], { view, requiredReadPacks: new Set(), exclusions: referenceExclusions }), []);
        assert.equal(referenceExclusions.length, 1);
    }
    const emptyExclusions: string[] = [];
    assert.deepEqual(await enumerateMigrationTargets({ dispatchDocumentSocket: async () => ({ result: [] }) }, new Set(['WorldPack']), [], { view, exclusions: emptyExclusions }), []);
    assert.equal(emptyExclusions.length, 0, 'a verified empty pack is different from an unavailable read');
    settingStore.clear(); assert.equal(packIsWritableWorld(pack), false, 'unavailable settings fail closed');
};

cases.access = async root => {
    const { transport } = await host(root);
    const candidate = fixture(path.join(root, 'modules/fixture'));
    fs.writeFileSync(path.join(candidate.root, 'logic.js'), 'export class Adapter {systemId="fixture";match(){return true} normalizeActorData(a){return {...a,id:a._id,img:"",derived:{}}}}');
    fs.writeFileSync(path.join(candidate.root, 'ui.js'), 'export default {}'); refreshRegistry();
    await worldBootstrapper.bootstrap(transport);
    const changes: Array<{ revision: number; keys: unknown[] }> = [];
    moduleWorldContext.on('changed', change => changes.push(change));
    const setting = { _id: 'access', key: 'core.compendiumConfiguration', value: JSON.stringify({ 'world.gear': { ownership: { PLAYER: 'NONE' } } }) };
    const ingress = async (action: string, result: unknown[]) => {
        const before = moduleWorldContext.snapshot().identity.contextRevision;
        transport.emit('foundry:modifyDocument', { type: 'Setting', action, operation: {}, result });
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.ok(moduleWorldContext.snapshot().identity.contextRevision > before, 'ownership-only ingress advances public context');
        assert.ok(changes.length > 0, 'the production ingress/bootstrap path publishes retirement');
        assert.deepEqual(changes.at(-1)!.keys, [], 'private settings never enter the public hint');
        assert.equal(JSON.stringify(changes).includes('PLAYER'), false);
    };
    await ingress('create', [setting]);
    await ingress('update', [{ ...setting, value: JSON.stringify({ 'world.gear': { ownership: { PLAYER: 'OBSERVER' } } }) }]);
    await ingress('delete', ['access']);
    const before = moduleWorldContext.snapshot().identity.contextRevision;
    await worldBootstrapper.refreshWorldContext();
    assert.equal(moduleWorldContext.snapshot().identity.contextRevision, before, 'identical observations coalesce');
    await worldBootstrapper.recover(transport);
    assert.ok(moduleWorldContext.snapshot().identity.contextRevision > before, 'reconnect reconciliation publishes a fresh revision');
    worldBootstrapper.reset('g8-test-finished');
};

cases.errors = async root => {
    // A real external .js importer is interpreted outside Core's ESM package
    // boundary by the supported tsx loader. Do not replace this with a mock.
    const file = path.join(root, 'managed-server.js');
    fs.writeFileSync(file, `import { SdkError, isSdkError } from '@sheet-delver/sdk';
        import { error, json } from '@sheet-delver/sdk/server';
        export { SdkError, isSdkError };
        export const apiRoutes={ check: async req=>{try{await req.runtime.check();return json({ok:true});}
        catch(e){return isSdkError(e)?error(e.code,e.message,e.status):error('internal','Internal server error');}} };`);
    const imported = await import(pathToFileURL(file).href);
    const external = imported.apiRoutes ?? imported.default.apiRoutes;
    const ExternalError = imported.SdkError ?? imported.default.SdkError;
    const externalRecognizes = imported.isSdkError ?? imported.default.isSdkError;
    for (const [code, status] of Object.entries(SDK_ERROR_STATUS)) {
        const thrown = new SdkError(code as keyof typeof SDK_ERROR_STATUS, 'Safe public detail');
        assert.ok(externalRecognizes(thrown), 'managed JS recognizes host errors across loaders');
        assert.ok(isSdkError(new ExternalError(code, 'Safe public detail')), 'host recognizes managed JS errors');
        const response = await external.check({ runtime: { check: async () => { throw thrown; } } });
        assert.equal(response.status, status); assert.equal((await response.json()).code, code);
    }
    const custom = await external.check({ runtime: { check: async () => { throw new SdkError('validation', 'Safe detail', 422); } } });
    assert.equal(custom.status, 422);
    class DomainError extends SdkError { constructor() { super('validation', 'Safe detail', 422); this.name = 'DomainError'; } }
    assert.ok(externalRecognizes(new DomainError()), 'valid subclasses retain typed custom status handling');
    for (const error of [new Error('private secret'), { name: 'SdkError', code: 'permission_denied', status: 403 },
        Object.assign(new Error('secret'), { code: 'permission_denied', status: 403 }), new ExternalError('bad-code', 'secret'), new ExternalError('validation', 'secret', 200)]) {
        assert.equal(isSdkError(error), false);
        const response = await external.check({ runtime: { check: async () => { throw error; } } });
        assert.equal(response.status, 500); assert.equal((await response.json()).error, 'Internal server error');
    }
};

cases['public-errors'] = async root => {
    const author = fixture(path.join(root, 'author'));
    const staged = path.join(root, 'staged'); fs.mkdirSync(staged);
    await packageMigrations(author.root, staged, author.info);
    const info = { ...author.info, manifest: { logic: 'logic.js', ui: 'ui.js', server: 'server.js' } };
    fs.writeFileSync(path.join(staged, 'info.json'), JSON.stringify(info));
    fs.writeFileSync(path.join(staged, 'logic.js'), 'export class Adapter {systemId="fixture";match(){return true}normalizeActorData(a){return {...a,id:a._id,img:"",derived:{}}}}');
    fs.writeFileSync(path.join(staged, 'ui.js'), 'export default {}');
    await build({ stdin: { contents: `import { SdkError, isSdkError } from '@sheet-delver/sdk';import { json, error } from '@sheet-delver/sdk/server';
        export const apiRoutes={probe:async req=>{const body=await req.json();if(body.unknown)throw new Error('secret upstream exception');
        if(body.uncaught)throw new SdkError(body.code,'Safe typed detail',body.status);
        try{if(body.host)await req.runtime.dataStore.get('../invalid');else throw new SdkError(body.code,'Safe typed detail',body.status);return json({ok:true})}
        catch(e){return isSdkError(e)?error(e.code,e.message,e.status):error('internal','Internal server error')}}};`, resolveDir: process.cwd(), sourcefile: 'generic-module.ts', loader: 'ts' },
        outfile: path.join(staged, 'server.js'), bundle: true, platform: 'node', format: 'esm', external: ['@sheet-delver/sdk', '@sheet-delver/sdk/server'] });
    const archive = path.join(root, 'fixture.tgz'); await tar.c({ gzip: true, file: archive, cwd: staged }, fs.readdirSync(staged));
    const originalArchive = fs.readFileSync(archive);
    const inTree = fs.mkdtempSync(path.join(process.cwd(), 'temp/g8-in-tree-'));
    try {
        for (const [data, source] of [[path.join(root, 'external'), 'modules'], [inTree, 'modules'], [path.join(root, 'development'), 'local/modules']]) {
            await host(data);
            const installed = path.join(data, source, 'fixture'); fs.mkdirSync(installed, { recursive: true });
            await tar.x({ file: archive, cwd: installed }); refreshRegistry();
            await worldBootstrapper.bootstrap((await import('@server/services/world/SystemService')).systemService.getSystemClient());
            const app = express(); app.use(express.json());
            app.use('/api/modules', createModuleRouter({ tryAuthenticateSession: (req, _res, next) => {
                req.foundryClient = { userId: 'service', isConnected: true } as never;
                req.userSession = { userId: 'service', username: 'service' } as never; next();
            } }));
            const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
            const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/modules/fixture/probe`;
            const request = (body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            try {
                for (const [code, status] of Object.entries(SDK_ERROR_STATUS)) for (const uncaught of [true, false]) {
                    const response = await request({ code, uncaught }); assert.equal(response.status, status, `${data}/${code}/${uncaught}`);
                    assert.equal((await response.json()).code, code);
                }
                assert.equal((await request({ host: true })).status, 400, 'packaged handler recognizes actual host DataStore validation');
                assert.equal((await request({ code: 'validation', status: 422 })).status, 422);
                const unknown = await request({ unknown: true }); assert.equal(unknown.status, 500);
                assert.deepEqual(await unknown.json(), { error: 'Internal server error', code: 'internal', status: 500 });
                assert.deepEqual(fs.readFileSync(archive), originalArchive, 'valid archive is never rewritten');
            } finally { await new Promise<void>(resolve => server.close(() => resolve())); worldBootstrapper.reset('g8-package-test'); }
        }
    } finally { fs.rmSync(inTree, { recursive: true, force: true }); }
};

export async function run() {
    for (const id of Object.keys(cases)) {
        const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--case', id], { encoding: 'utf8', timeout: 60_000 });
        assert.equal(result.status, 0, `${id}: ${result.stdout}\n${result.stderr}`);
    }
    console.log('ADR-0064 regressions: v13/v14 orphan startup/cleanup, locks/advisory reads, access and packaged errors passed');
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const id = process.argv[process.argv.indexOf('--case') + 1];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-g8-core-'));
    (cases[id] ? cases[id](root) : run()).then(() => console.log(`${id}: PASS`)).catch(error => { console.error(error); process.exitCode = 1; })
        .finally(() => fs.rmSync(root, { recursive: true, force: true }));
}
