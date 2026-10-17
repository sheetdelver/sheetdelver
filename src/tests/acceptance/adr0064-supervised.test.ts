/** Explicit operator check: real manager/Core/Next, isolated data, fake upstream only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import express from 'express';
import { Server } from 'socket.io';
import { initDataDir } from '@server/core/paths';
import { createAdminAccount } from '@server/security/adminCredentialStore';
import { fixture } from '../unit/world/module-world-migrations.test';
import { packageMigrations } from '@modules/registry/migrations/compile';
import { io as connectBrowserSocket } from 'socket.io-client';
import { createMaintenanceCandidate, maintenanceInventory, expectedMaintenanceSource, maintenanceUuidOracle, type FixtureDocument } from '../fixtures/maintenanceInventory';

if (!process.argv.includes('--run-isolated')) throw new Error('Explicit --run-isolated required; never uses an existing Foundry/Core instance');
const repository = process.cwd();
const complete = process.argv.includes('--complete-matrix');
const recovery = process.argv.includes('--recover-writes');
const onlineEntry = process.argv.includes('--online-entry');
const archiveOperation = process.argv.find(arg => arg.startsWith('--archive-op='))?.split('=')[1] as 'install' | 'upgrade' | undefined;
const localSwitch = process.argv.includes('--local-switch');
const cancelReview = process.argv.includes('--cancel-review');
const noOp = process.argv.includes('--no-op') || cancelReview;
const restartReview = process.argv.includes('--restart-review');
const restoreLegacy = process.argv.includes('--restore-legacy');
const restartPreparation = process.argv.includes('--restart-preparation');
const manualEntry = onlineEntry || !!archiveOperation || localSwitch || noOp;
const counts = (process.argv.find(arg => arg.startsWith('--inventory='))?.slice(12) ?? '30,30').split(',').map(Number);
const inventory = maintenanceInventory(counts[0], counts[1], manualEntry);
const expected = expectedMaintenanceSource(inventory);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-cr64-supervised-'));
const startedAt = Date.now(); const samples: Array<Record<string, unknown>> = [];
let maxStatusMs = 0;
const workspace = path.join(root, 'workspace'); const data = path.join(root, 'data');
fs.mkdirSync(workspace); fs.mkdirSync(path.join(data, 'config'), { recursive: true });
for (const file of ['src', 'public', 'patches', 'package.json', 'package-lock.json', 'tsconfig.json', 'next.config.ts', 'postcss.config.cjs']) {
    fs.cpSync(path.join(repository, file), path.join(workspace, file), { recursive: true });
}
fs.symlinkSync(path.join(repository, 'node_modules'), path.join(workspace, 'node_modules'), 'dir');
// Generate only Core-owned aliases before invoking the real packaging CLI.
fs.mkdirSync(path.join(workspace, '.managed'));
fs.copyFileSync(path.join(repository, '.managed/tsconfig.paths.json'), path.join(workspace, '.managed/tsconfig.paths.json'));
const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(APP_|FOUNDRY_|SHEET_DELVER_)/.test(key))), NODE_ENV: 'development' };
env.NPM_CONFIG_OFFLINE = 'true'; env.NEXT_TELEMETRY_DISABLED = '1';
const upstream = express(); upstream.use(express.json());
const wire = http.createServer(upstream); const sockets = new Server(wire);
const users = [{ _id: 'service', name: 'service', role: 4 }, ...onlineEntry ? [{ _id: 'player', name: 'Player', role: 1 }, { _id: 'human', name: 'Human GM', role: 4 }] : []];
const actor = { _id: 'a', name: 'Controlled Actor', type: 'character', system: { fixed: false }, items: [], effects: [], ownership: { default: 0 } };
const game = { world: { id: 'w1', title: 'Controlled world' }, system: { id: 'fixture', version: process.argv.includes('--cumulative') ? '2.0.0' : '1.0.0' },
    release: { generation: Number(process.argv.find(arg => arg.startsWith('--generation='))?.split('=')[1] ?? 14), build: '367' }, userId: 'service', users,
    scenes: complete ? inventory.scenes : [], packs: complete ? inventory.metadata : [], activeUsers: [] };
let writes = 0;
let nativeReads = 0; let wireBytes = 0;
let pendingUserAck: (() => void) | undefined; let userWrites = 0;
const browserSockets: ReturnType<typeof connectBrowserSocket>[] = [];
const written: string[] = [];
upstream.get('/api/status', (_req, res) => res.json({ active: true, world: 'w1', system: 'fixture', version: '14.367' }));
upstream.post('/join', (req, res) => { const id = req.body?.userId ?? req.body?.userid ?? users.find(row => row.name === req.body?.username)?._id ?? 'service';
    res.cookie('session', id); res.json({ success: true }); });
sockets.on('connection', socket => {
    socket.data.userId = socket.handshake.auth.session ?? socket.handshake.query.session ?? 'service';
    socket.emit('session', { userId: socket.data.userId });
    socket.on('getJoinData', ack => ack(game)); socket.on('world', ack => ack(game)); socket.on('getWorldStatus', ack => ack(true));
    socket.on('modifyDocument', (request, ack) => {
        const { type, action, operation } = request;
        if (complete) {
            const roots = operation.pack ? inventory.packs[operation.pack] : type === 'Actor' ? inventory.actors : type === 'Item' ? inventory.items : type === 'Scene' ? inventory.scenes : type === 'User' ? users : [];
            let rows: FixtureDocument[] = roots;
            if (operation.parentUuid) {
                const parts = operation.parentUuid.split('.');
                let offset = parts[0] === 'Compendium' ? 3 : 0;
                const rootType = parts[offset++]; const rootId = parts[offset++];
                const sourceRows = operation.pack ? inventory.packs[operation.pack] : rootType === 'Actor' ? inventory.actors : rootType === 'Item' ? inventory.items : inventory.scenes;
                let parent: FixtureDocument = sourceRows.find(row => row._id === rootId)!;
                while (offset < parts.length) {
                    const kind = parts[offset++]; const id = parts[offset++];
                    parent = kind === 'ActorDelta' ? parent.delta : parent[kind === 'Item' ? 'items' : kind === 'Token' ? 'tokens' : 'effects'].find((row: FixtureDocument) => row._id === id);
                }
                rows = type === 'ActorDelta' ? [parent.delta] : parent[type === 'Item' ? 'items' : 'effects'];
            }
            if (action === 'update') {
                for (const update of operation.updates) {
                    const target = rows.find(row => row._id === update._id)!; assert.ok(target, 'native target exists');
                    for (const [field, value] of Object.entries(update)) {
                        if (field === '_id') continue;
                        assert.ok(['system.fixed', 'changes'].includes(field), `bounded update: ${field}`);
                        const parts = field.split('.'); let cursor = target;
                        for (const part of parts.slice(0, -1)) cursor = (cursor[part] ??= {});
                        cursor[parts.at(-1)!] = structuredClone(value);
                    }
                    if (onlineEntry && socket.data.userId !== 'service') userWrites++;
                    else { writes++; written.push(`${operation.pack ?? operation.parentUuid ?? ''}:${type}:${update._id}`); }
                    if (recovery && writes === 7) { ack({ error: 'Controlled lost receipt after committed write' }); return; }
                }
            } else { assert.equal(action, 'get'); nativeReads++; }
            if (operation.query?._id__in) rows = rows.filter(row => operation.query._id__in.includes(row._id));
            const response = { type, action, operation, result: rows };
            if (onlineEntry && socket.data.userId !== 'service' && action === 'update') { pendingUserAck = () => ack(response); return; }
            wireBytes += Buffer.byteLength(JSON.stringify(response)); ack(response); return;
        }
        if (action === 'update') {
            assert.equal(type, 'Actor'); assert.deepEqual(operation.updates, [{ _id: 'a', 'system.fixed': true }]);
            writes++; actor.system.fixed = true;
        } else assert.equal(action, 'get');
        ack({ type, action, operation, result: type === 'Actor' ? [actor] : type === 'User' ? users : [] });
    });
});
await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
const upstreamPort = (wire.address() as { port: number }).port;
async function unusedPort() { const server = http.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port; }
const appPort = await unusedPort(); const apiPort = await unusedPort();
const settings = { app: { host: '127.0.0.1', protocol: 'http', port: appPort, 'api-port': apiPort },
    foundry: { host: '127.0.0.1', protocol: 'http', port: upstreamPort, username: 'service' }, debug: { level: 3 },
    security: { admin: { 'allowed-networks': ['127.0.0.0/8'] } } };
fs.writeFileSync(path.join(data, 'config/settings.yaml'), JSON.stringify(settings));
fs.mkdirSync(path.join(data, 'cache/core'), { recursive: true });
fs.writeFileSync(path.join(data, 'cache/core/worlds.json'), JSON.stringify({ worlds: {}, currentWorldId: null }));
initDataDir(data); await createAdminAccount('isolated-acceptance-password');
const source = complete ? createMaintenanceCandidate(path.join(root, 'author-source'), process.argv.includes('--cumulative')) : fixture(path.join(root, 'author-source')); const installed = path.join(data, 'modules/fixture');
if (onlineEntry) Object.assign(source.info, { compendiumPacks: { packs: [{ id: 'world.unusualItems', type: 'Item', hydrate: true }] } });
fs.mkdirSync(installed, { recursive: true }); await packageMigrations(source.root, installed, source.info);
fs.writeFileSync(path.join(installed, 'info.json'), JSON.stringify(source.info)); fs.writeFileSync(path.join(installed, 'ui.js'), 'export default {}');
const trace = path.join(root, 'adapter-events.jsonl'); const hold = path.join(root, 'hold-preparation');
const ticks = path.join(root, 'adapter-ticks.log');
if (!manualEntry) fs.writeFileSync(hold, 'controlled pause');
fs.writeFileSync(path.join(installed, 'logic.js'), `import fs from 'node:fs';
export class Adapter { systemId='fixture'; match(){return true}
 constructor(){fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({event:'constructed',pid:process.pid})+'\\n')}
 async initialize(){fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({event:'initialize',pid:process.pid})+'\\n');
 while(fs.existsSync(${JSON.stringify(hold)})) await new Promise(resolve=>setTimeout(resolve,50));
 if(${onlineEntry})setInterval(()=>fs.appendFileSync(${JSON.stringify(ticks)},process.pid+'\\n'),50).unref();}
 normalizeActorData(actor){return {...actor,id:actor._id,img:'',derived:{fixed:actor.system.fixed}}} }`);
let archive: string | undefined;
if (archiveOperation) {
    const authorData = path.join(root, 'package-author'); const authorModule = path.join(authorData, 'local/modules/fixture');
    fs.mkdirSync(path.dirname(authorModule), { recursive: true }); fs.cpSync(installed, authorModule, { recursive: true });
    const packaged = spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/tools/modules/package-module.ts', 'fixture', '--data-dir', authorData],
        { cwd: workspace, env: { ...env, SHEET_DELVER_DATA: authorData }, encoding: 'utf8', timeout: 60_000 });
    fs.writeFileSync(path.join(root, 'package.log'), `${packaged.stdout}\n${packaged.stderr}`); assert.equal(packaged.status, 0, `packaging: ${packaged.stderr}`);
    archive = path.join(authorData, 'dist/modules/fixture-1.0.0.tgz'); assert.ok(fs.existsSync(archive));
    const manifest = JSON.parse(fs.readFileSync(path.join(authorData, 'dist/modules/fixture-1.0.0.manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 'sheet-delver-release.v2');
    fs.rmSync(installed, { recursive: true, force: true });
}
if (archiveOperation === 'upgrade' || localSwitch) {
    const previous = localSwitch ? path.join(data, 'local/modules/fixture') : installed; fs.mkdirSync(previous, { recursive: true });
    fs.writeFileSync(path.join(previous, 'info.json'), JSON.stringify({ ...source.info, version: '0.9.0' }));
    fs.writeFileSync(path.join(previous, 'ui.js'), 'export default {}');
    fs.writeFileSync(path.join(previous, 'logic.js'), "export class Adapter {systemId='fixture';match(){return true}normalizeActorData(actor){return {...actor,id:actor._id,img:'',derived:{}}}}");
    if (archiveOperation === 'upgrade') fs.writeFileSync(path.join(data, 'modules/artifacts.json'), JSON.stringify({ version: 1,
        artifacts: { fixture: { moduleId: 'fixture', version: '0.9.0', source: 'local://previous-isolated-artifact', installedAt: Date.now() } }, verifications: {} }));
}
const logFile = path.join(root, 'manager.log'); const log = fs.openSync(logFile, 'a');
const manager = spawn(process.execPath, ['--import', 'tsx', 'src/scripts/start-server.ts', 'dev', `--data-dir=${data}`],
    { cwd: workspace, env: { ...env, SHEET_DELVER_DATA: data }, stdio: ['ignore', log, log] });
const sampling = setInterval(() => {
    const pids = [...fs.readFileSync(logFile, 'utf8').matchAll(/Core Service \| Started \(pid=(\d+)/g)].map(row => Number(row[1]));
    const pid = pids.at(-1); if (!pid) return;
    try {
        const memory = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ');
        const io = fs.readFileSync(`/proc/${pid}/io`, 'utf8');
        samples.push({ atMs: Date.now() - startedAt, pid, rssKiB: Number(memory.match(/VmRSS:\s+(\d+)/)?.[1]),
            peakRssKiB: Number(memory.match(/VmHWM:\s+(\d+)/)?.[1]), cpuTicks: Number(stat[11]) + Number(stat[12]),
            readChars: Number(io.match(/rchar:\s+(\d+)/)?.[1]), writeChars: Number(io.match(/wchar:\s+(\d+)/)?.[1]) });
    } catch { /* task-owned process replacement expected */ }
}, 500);
const origin = `http://127.0.0.1:${appPort}`; const api = `http://127.0.0.1:${apiPort}`;
let cookie = ''; let csrf = '';
async function request(url: string, body?: unknown) {
    return fetch(`${api}${url}`, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(3000),
        headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-Admin-Csrf-Token': csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function until<T>(label: string, operation: () => Promise<T | false>, timeout = complete ? 300_000 : 90_000): Promise<T> {
    const end = Date.now() + timeout;
    while (Date.now() < end) { try { const result = await operation(); if (result !== false) return result; } catch { /* startup/replacement expected */ }
        if (manager.exitCode !== null) throw new Error(`Manager exited: ${manager.exitCode}`);
        await new Promise(resolve => setTimeout(resolve, 200)); }
    throw new Error(`Timed out: ${label}; inspect ${logFile}`);
}
async function acceptance() { try {
    await until('Core admin ready', async () => (await request('/admin/auth/status')).ok || false);
    const login = await request('/admin/auth/login', { password: 'isolated-acceptance-password' }); assert.equal(login.status, 200);
    cookie = login.headers.getSetCookie()[0].split(';')[0]; csrf = (await login.json()).csrfToken;
    if (manualEntry && !onlineEntry) {
        await until('normal serving before explicit maintenance', async () => (await (await request('/api/status')).json()).initialized === true || false);
        if (!noOp) { Object.assign(inventory, maintenanceInventory(counts[0], counts[1], false)); game.scenes = inventory.scenes;
            Object.assign(expected, expectedMaintenanceSource(inventory)); }
        fs.writeFileSync(hold, 'controlled preparation pause');
        let advisory;
        if (archive) {
            const response = await fetch(`${api}/admin/manager/fixture/archive/dry-run/${archiveOperation}?approveTrustOverride=true&approvePermissionEscalation=true`, {
                method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-Admin-Csrf-Token': csrf, 'Content-Type': 'application/gzip' }, body: fs.readFileSync(archive), signal: AbortSignal.timeout(60_000) });
            assert.equal(response.status, 200); const result = await response.json();
            assert.equal(result.wouldProceed, true, JSON.stringify(result.blockingReasons)); advisory = result.migration;
        } else {
            const response = await request('/admin/module-upgrades/source/fixture/preview', { source: 'managed' }); assert.equal(response.status, 200); advisory = await response.json();
        }
        assert.ok(advisory?.id); assert.equal((await request('/admin/module-maintenance/enter', { planId: advisory.id })).status, 202);
    }
    if (onlineEntry) {
        await until('all-current normal bootstrap', async () => (await (await request('/api/status')).json()).initialized === true || false);
        assert.equal(fs.existsSync(path.join(data, 'config/module-upgrades/maintenance.json')), false, 'all-current bootstrap does not request repair approval');
        for (const username of ['Player', 'Human GM']) {
            const response = await fetch(`${api}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) });
            assert.equal(response.status, 200);
            const userCookie = response.headers.getSetCookie()[0].split(';')[0];
            const socket = connectBrowserSocket(api, { transports: ['websocket'], reconnection: false, extraHeaders: { Cookie: userCookie } });
            browserSockets.push(socket);
            await new Promise<void>(resolve => socket.once('connect', resolve));
            assert.equal((await fetch(`${api}/api/actors`, { headers: { Cookie: userCookie, Origin: origin } })).status, 200);
            if (username === 'Player') {
                const packRead = await fetch(`${api}/api/foundry/document?uuid=Compendium.world.unusualItems.Item.packedItem`, { headers: { Cookie: userCookie, Origin: origin } });
                assert.equal(packRead.status, 200, `real HTTP/SDK pack read for generation ${game.release.generation}`);
                assert.equal((await packRead.json())._id, 'packedItem');
            }
        }
        const playerLogin = await fetch(`${api}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Player' }) });
        const playerCookie = playerLogin.headers.getSetCookie()[0].split(';')[0];
        Object.assign(inventory, maintenanceInventory(counts[0], counts[1], false)); game.scenes = inventory.scenes;
        Object.assign(expected, expectedMaintenanceSource(inventory));
        const pending = fetch(`${api}/api/actors/a0`, { method: 'PATCH', headers: { Cookie: playerCookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ 'system.fixed': false }) });
        await until('ordinary native write awaiting receipt', async () => !!pendingUserAck || false);
        const advisory = await request('/admin/module-upgrades/source/fixture/preview', { source: 'managed' }); assert.equal(advisory.status, 200);
        const preview = await advisory.json();
        fs.writeFileSync(hold, 'controlled maintenance preparation pause');
        assert.equal((await request('/admin/module-maintenance/enter', { planId: preview.id })).status, 202);
        const persisted = JSON.parse(fs.readFileSync(path.join(data, 'config/module-upgrades/maintenance.json'), 'utf8'));
        assert.equal(persisted.stage, 'entering'); assert.equal(userWrites, 1); assert.equal(writes, 0);
        pendingUserAck!(); assert.equal((await pending).status, 503, 'native receipt drains, but stale ordinary response remains fenced');
    }
    const maintained = await until('isolated authoritative review', async () => {
        const state = await (await request('/admin/module-maintenance')).json();
        return state.mode?.stage === 'review' ? state : false;
    });
    assert.equal(fs.existsSync(trace), onlineEntry || localSwitch || noOp, 'no candidate adapter constructed before source compatibility; only prior current serving adapter may exist');
    if (onlineEntry) {
        const before = fs.readFileSync(ticks, 'utf8'); await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(fs.readFileSync(ticks, 'utf8'), before, 'ordinary adapter timers cannot survive the normal-process barrier');
        assert.equal([...sockets.sockets.sockets.values()].filter(socket => socket.data.userId !== 'service').length, 0, 'old user transports exited');
    }
    assert.equal((await request('/api/actors')).status, 503);
    const before = fs.readFileSync(logFile, 'utf8');
    const initialPids = [...before.matchAll(/(?:Core Service spawned|Application Shell spawned) \(pid=(\d+)\)/g)].map(row => Number(row[1]));
    assert.equal(initialPids.length, 3, 'normal Core/Next replaced by one maintenance Core, no Next');
    assert.equal(maintained.mode.stoppedWorkers.length, 2);
    for (const entry of ['src/scripts/start-server.ts', 'src/server/index.ts']) {
        const contender = spawnSync(process.execPath, ['--import', 'tsx', entry, ...entry.includes('start-server') ? ['dev'] : [], `--data-dir=${data}`],
            { cwd: workspace, env: { ...env, SHEET_DELVER_DATA: data }, encoding: 'utf8', timeout: 15_000 });
        assert.notEqual(contender.status, 0, 'second supervisor/direct Core cannot share this maintenance data directory');
        assert.match(`${contender.stdout}\n${contender.stderr}`, /live Core owns this data directory/);
    }
    if (restartReview) {
        assert.equal(writes, 0);
        const cores = [...fs.readFileSync(logFile, 'utf8').matchAll(/Core Service \| Started \(pid=(\d+)/g)].map(row => Number(row[1]));
        process.kill(cores.at(-1)!, 'SIGKILL');
        await until('unapproved review Core replaced', async () => [...fs.readFileSync(logFile, 'utf8').matchAll(/Core Service \| Started \(pid=(\d+)/g)].length > cores.length || false);
        await until('review auth reachable', async () => (await request('/admin/auth/status')).ok || false);
        const login = await request('/admin/auth/login', { password: 'isolated-acceptance-password' }); assert.equal(login.status, 200);
        cookie = login.headers.getSetCookie()[0].split(';')[0]; csrf = (await login.json()).csrfToken;
        const restoredReview = await until('exact review retained', async () => { const status = await (await request('/admin/module-maintenance')).json(); return status.mode?.stage === 'review' ? status : false; });
        assert.equal(restoredReview.preview.id, maintained.preview.id); assert.equal(writes, 0, 'restart cannot approve new work');
    }
    assert.equal((await request('/api/login', { username: 'player' })).status, 503);
    const reconnect = connectBrowserSocket(api, { transports: ['websocket'], reconnection: false }); browserSockets.push(reconnect);
    const hint = await new Promise<{ maintenance?: unknown; isAuthenticated?: boolean }>(resolve => reconnect.once('systemStatus', resolve));
    assert.ok(hint.maintenance); assert.equal(hint.isAuthenticated, false);
    reconnect.emit('actor:update', { actorId: 'a0', updates: { 'system.fixed': false } });
    assert.equal([...sockets.sockets.sockets.values()].filter(socket => socket.data.userId !== 'service').length, 0, 'reconnection cannot restore a native user transport');
    assert.equal((await request('/admin/worlds/launch', {})).status, 503);
    for (const path of ['/api/chat', '/api/combats', '/api/modules/fixture/data', '/debug/actors']) assert.equal((await request(path)).status, 503);
    assert.equal((await request('/admin/module-maintenance/approve', { planId: maintained.preview.id, backupAcknowledged: false })).status, 400);
    assert.equal((await request('/admin/module-maintenance/approve', { planId: 'wrong-plan', backupAcknowledged: true })).status, 409);
    if (cancelReview) {
        fs.unlinkSync(hold);
        assert.equal((await request('/admin/module-maintenance/cancel', {})).status, 202);
        const status = await until('pre-write cancellation restored verified serving', async () => { const status = await (await request('/api/status')).json(); return status.initialized ? status : false; });
        assert.equal(status.runtimeToken, maintained.mode.id); assert.equal(writes, 0); assert.deepEqual(inventory, expected);
        assert.equal(fs.existsSync(path.join(data, 'config/module-upgrades/jobs', `${maintained.mode.id}.json`)), false);
        fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ native: false, cancelReview: true, completed: true, writes, sourceOracle: true, runtimeToken: status.runtimeToken }, null, 2));
        console.log(`PASS: public pre-write cancellation, no write authority, validated normal serving. Evidence: ${root}`);
        return;
    }
    const preview = maintained.preview;
    let approvedInBrowser = false;
    if (process.env.SD_PLAYWRIGHT_MODULE) {
        const { chromium } = await import(process.env.SD_PLAYWRIGHT_MODULE);
        const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
        const styles: Record<string, string> = {};
        try {
            for (const width of [320, 390, 820, 1440]) for (const colorScheme of ['light', 'dark'] as const) {
                const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
                const [name, ...value] = cookie.split('=');
                await context.addCookies([{ name, value: value.join('='), url: origin, httpOnly: true }]);
                const page = await context.newPage();
                await page.goto(`${origin}/admin/modules`);
                await page.locator('#admin:not([hidden])').waitFor();
                await page.waitForFunction(() => document.getElementById('phase')?.textContent?.includes('review'));
                assert.equal(await page.locator('#approve').isDisabled(), true);
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
                styles[colorScheme] = await page.locator('section').first().evaluate((element: Element) => getComputedStyle(element).backgroundColor);
                await page.keyboard.press('Tab'); await page.keyboard.press('Escape');
                assert.ok(await page.getByText('World access paused', { exact: true }).isVisible());
                await page.screenshot({ path: path.join(root, `maintenance-${colorScheme}-${width}.png`), fullPage: true });
                if (width === 1440 && colorScheme === 'dark') {
                    await page.locator('#backup').check();
                    const response = page.waitForResponse((res: { url(): string }) => res.url().endsWith('/admin/module-maintenance/approve'));
                    await page.locator('#approve').click(); assert.equal((await response).status(), 202); approvedInBrowser = true;
                }
                await context.close();
            }
            assert.notEqual(styles.light, styles.dark);
        } finally { await browser.close(); }
    }
    if (!approvedInBrowser) assert.equal((await request('/admin/module-maintenance/approve', { planId: preview.id, backupAcknowledged: true })).status, 202);
    const jobId = maintained.mode.id;
    const jobFile = path.join(data, 'config/module-upgrades/jobs', `${jobId}.json`);
    if (recovery) {
        await until('lost receipt stops in recoverable maintenance', async () => {
            const state = await (await request('/admin/module-maintenance')).json(); return state.mode?.stage === 'recovery-required' ? state : false;
        });
        assert.equal(writes, 7);
        assert.equal((await request('/admin/module-maintenance/resume', {})).status, 202, 'same approval resumes after lost receipt');
        await until('confirmed prefix before process termination', async () => writes >= 20 || false);
        const cores = [...fs.readFileSync(logFile, 'utf8').matchAll(/Core Service \| Started \(pid=(\d+)/g)].map(row => Number(row[1]));
        process.kill(cores.at(-1)!, 'SIGKILL'); // known isolated task-owned Core only
        await until('crashed Core replaced', async () => [...fs.readFileSync(logFile, 'utf8').matchAll(/Core Service \| Started \(pid=(\d+)/g)].length > cores.length || false);
        await until('replacement authentication reachable', async () => (await request('/admin/auth/status')).ok || false);
        // Opaque admin sessions survive planned handoff, not an unplanned kill.
        // Reauthenticate; the approved migration itself requires no new approval.
        const relogin = await request('/admin/auth/login', { password: 'isolated-acceptance-password' }); assert.equal(relogin.status, 200);
        cookie = relogin.headers.getSetCookie()[0].split(';')[0]; csrf = (await relogin.json()).csrfToken;
    }
    await until('real replacement into preparation', async () => {
        const start = Date.now(); const response = await request('/admin/module-maintenance');
        assert.equal(response.status, 200); maxStatusMs = Math.max(maxStatusMs, Date.now() - start);
        return fs.existsSync(trace) && JSON.parse(fs.readFileSync(jobFile, 'utf8')).phase === 'verifying' || false;
    });
    if (restartPreparation) {
        const priorWrites = writes;
        const cores = [...fs.readFileSync(logFile, 'utf8').matchAll(/Core Service \| Started \(pid=(\d+)/g)].map(row => Number(row[1]));
        process.kill(cores.at(-1)!, 'SIGKILL');
        await until('preparation Core replaced', async () => [...fs.readFileSync(logFile, 'utf8').matchAll(/Core Service \| Started \(pid=(\d+)/g)].length > cores.length || false);
        await until('replacement preparation authentication reachable', async () => (await request('/admin/auth/status')).ok || false);
        const login = await request('/admin/auth/login', { password: 'isolated-acceptance-password' }); assert.equal(login.status, 200);
        cookie = login.headers.getSetCookie()[0].split(';')[0]; csrf = (await login.json()).csrfToken;
        await until('replacement actually reaches fresh held preparation', async () => {
            const events = fs.readFileSync(trace, 'utf8').trim().split('\n').map(row => JSON.parse(row));
            return events.some(row => row.event === 'initialize' && !cores.includes(row.pid)) || false;
        });
        assert.equal(writes, priorWrites, 'preparation restart does not repeat confirmed native writes');
    }
    assert.equal(writes, noOp ? 0 : complete ? maintenanceUuidOracle(expected).length : 1); assert.equal((await request('/admin/module-upgrades')).status, 200, 'admin session survives supervised restart');
    assert.equal((await request('/api/actors')).status, 503, 'replacement does not serve before adapter preparation');
    const pending = JSON.parse(fs.readFileSync(jobFile, 'utf8')); assert.ok(pending.leaseToken); assert.equal(pending.possibleWrite, !noOp);
    fs.unlinkSync(hold);
    await until('completed activation', async () => JSON.parse(fs.readFileSync(jobFile, 'utf8')).phase === 'completed' || false);
    const publicStatus = await until('normal serving restored', async () => {
        const status = await (await request('/api/status')).json(); return status.initialized === true ? status : false;
    });
    assert.equal(publicStatus.runtimeToken, jobId);
    assert.equal((await request('/api/actors', {})).status, 409, 'old browser without first runtime token cannot mutate');
    const after = fs.readFileSync(logFile, 'utf8');
    const replacedPids = [...after.matchAll(/(?:Core Service spawned|Application Shell spawned) \(pid=(\d+)\)/g)].map(row => Number(row[1]));
    const extraRestarts = Number(recovery) + Number(restartPreparation) + Number(restartReview);
    assert.equal(replacedPids.length, 5 + extraRestarts); assert.ok(replacedPids[3] !== initialPids[0] && replacedPids[4] !== initialPids[1]);
    assert.match(after, /Full-stack restart requested/);
    const actualCorePids = [...after.matchAll(/Core Service \| Started \(pid=(\d+)/g)].map(row => Number(row[1]));
    assert.equal(actualCorePids.length, 3 + extraRestarts); assert.notEqual(actualCorePids[0], actualCorePids[1]);
    if (complete) {
        assert.deepEqual(inventory, expected, 'independent source oracle includes unknowns, null deltas, tombstones, pack identities and all changes');
        assert.equal(new Set(written).size, written.length, 'no duplicate confirmed writes');
        assert.deepEqual(preview.plan.operations.map((row: { uuid: string }) => row.uuid).sort(), noOp ? [] : maintenanceUuidOracle(expected));
    }
    let restoredEvidence;
    if (restoreLegacy) {
        const priorWrites = writes; fs.writeFileSync(hold, 'hold restored source preparation');
        Object.assign(inventory, maintenanceInventory(counts[0], counts[1], false)); game.scenes = inventory.scenes;
        // Controlled upstream replacement: old source returns with a completed
        // durable ledger. Do not fake the installed compatibility callback.
        for (const socket of sockets.sockets.sockets.values()) socket.disconnect(true);
        const restored = await until('restored legacy requires fresh authoritative review', async () => {
            const result = await request('/admin/module-maintenance');
            if (result.status === 401) { const login = await request('/admin/auth/login', { password: 'isolated-acceptance-password' });
                cookie = login.headers.getSetCookie()[0].split(';')[0]; csrf = (await login.json()).csrfToken; return false; }
            const status = await result.json(); return status.mode?.stage === 'review' && status.mode.id !== jobId ? status : false;
        });
        assert.equal(writes, priorWrites, 'completed ledger does not authorize repair of externally restored sources');
        assert.equal((await request('/admin/module-maintenance/approve', { planId: restored.preview.id, backupAcknowledged: true })).status, 202);
        const restoredFile = path.join(data, 'config/module-upgrades/jobs', `${restored.mode.id}.json`);
        await until('restored source verified before preparation', async () => fs.existsSync(restoredFile) && JSON.parse(fs.readFileSync(restoredFile, 'utf8')).phase === 'verifying' || false);
        fs.unlinkSync(hold);
        await until('restored source job completed', async () => JSON.parse(fs.readFileSync(restoredFile, 'utf8')).phase === 'completed' || false);
        await until('restored source serving', async () => (await (await request('/api/status')).json()).initialized === true || false);
        assert.deepEqual(inventory, expected); assert.equal(writes - priorWrites, maintenanceUuidOracle(expected).length);
        restoredEvidence = { jobId: restored.mode.id, writes: writes - priorWrites, freshApprovalRequired: true, completed: true };
    }
    function bytes(directory: string): number { return fs.readdirSync(directory, { withFileTypes: true }).reduce((sum, file) => sum + (file.isDirectory() ? bytes(path.join(directory, file.name)) : fs.statSync(path.join(directory, file.name)).size), 0); }
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ manager: manager.pid, initialPids, replacementPids: replacedPids.slice(2), actualCorePids, appPort, apiPort,
        upstreamPort, jobId, phases: ['restarting', 'verifying', 'completed'], pendingLeaseObserved: true, admissionBeforeConstruction: true,
        adminDuringPreparation: 200, playerDuringPreparation: 503, staleMutationAfterActivation: 409,
        writes, userWrites, onlineEntry, archiveOperation, localSwitch, noOp, restartPreparation, restartReview, restoredEvidence, cumulative: process.argv.includes('--cumulative'), nativeReads, wireBytes, elapsedMs: Date.now() - startedAt, maxStatusMs, journalBytes: bytes(path.join(data, 'config/module-upgrades')),
        resourceSamples: samples, fullSourceOracle: complete, approvedInBrowser, generation: game.release.generation,
        inventory: complete ? { actors: counts[0], embeddedItems: counts[0] * counts[1], actorAndItemEffects: counts[0] * (2 + Math.ceil(counts[1] / 4)),
            expectedWrites: maintenanceUuidOracle(expected).length, checked: preview.plan.checked } : undefined,
        adapter: fs.readFileSync(trace, 'utf8'), native: false }, null, 2));
    console.log(`PASS: actual manager/Core/Next replacement, durable lease/job, pre-adapter admission, admin continuity and first-token fence. Evidence: ${root}`);
} finally {
    browserSockets.forEach(socket => socket.disconnect());
    clearInterval(sampling);
    if (manager.exitCode === null) manager.kill('SIGTERM');
    await Promise.race([new Promise(resolve => manager.once('close', resolve)), new Promise(resolve => setTimeout(resolve, 15_000))]);
    sockets.close(); await new Promise<void>(resolve => wire.close(() => resolve())); fs.closeSync(log);
} }
await acceptance();
