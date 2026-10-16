/** Explicit operator check: real manager/Core/Next, isolated data, fake upstream only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import express from 'express';
import { Server } from 'socket.io';
import { initDataDir } from '@server/core/paths';
import { createAdminAccount } from '@server/security/adminCredentialStore';
import { fixture } from '../unit/world/module-world-migrations.test';
import { packageMigrations } from '@modules/registry/migrations/compile';

if (!process.argv.includes('--run-isolated')) throw new Error('Explicit --run-isolated required; never uses an existing Foundry/Core instance');
const repository = process.cwd();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-cr64-supervised-'));
const workspace = path.join(root, 'workspace'); const data = path.join(root, 'data');
fs.mkdirSync(workspace); fs.mkdirSync(path.join(data, 'config'), { recursive: true });
for (const file of ['src', 'public', 'patches', 'package.json', 'package-lock.json', 'tsconfig.json', 'next.config.ts', 'postcss.config.cjs']) {
    fs.cpSync(path.join(repository, file), path.join(workspace, file), { recursive: true });
}
fs.symlinkSync(path.join(repository, 'node_modules'), path.join(workspace, 'node_modules'), 'dir');
const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(APP_|FOUNDRY_|SHEET_DELVER_)/.test(key))), NODE_ENV: 'development' };
env.NPM_CONFIG_OFFLINE = 'true'; env.NEXT_TELEMETRY_DISABLED = '1';
const upstream = express(); upstream.use(express.json());
const wire = http.createServer(upstream); const sockets = new Server(wire);
const users = [{ _id: 'service', name: 'service', role: 4 }];
const actor = { _id: 'a', name: 'Controlled Actor', type: 'character', system: { fixed: false }, items: [], effects: [], ownership: { default: 0 } };
const game = { world: { id: 'w1', title: 'Controlled world' }, system: { id: 'fixture', version: '1.0.0' },
    release: { generation: 14, build: '367' }, userId: 'service', users, scenes: [], activeUsers: [] };
let writes = 0;
upstream.get('/api/status', (_req, res) => res.json({ active: true, world: 'w1', system: 'fixture', version: '14.367' }));
upstream.post('/join', (_req, res) => { res.cookie('session', 'controlled-service'); res.json({ success: true }); });
sockets.on('connection', socket => {
    socket.emit('session', { userId: 'service' });
    socket.on('getJoinData', ack => ack(game)); socket.on('world', ack => ack(game)); socket.on('getWorldStatus', ack => ack(true));
    socket.on('modifyDocument', (request, ack) => {
        const { type, action, operation } = request;
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
const source = fixture(path.join(root, 'author-source')); const installed = path.join(data, 'modules/fixture');
fs.mkdirSync(installed, { recursive: true }); await packageMigrations(source.root, installed, source.info);
fs.writeFileSync(path.join(installed, 'info.json'), JSON.stringify(source.info)); fs.writeFileSync(path.join(installed, 'ui.js'), 'export default {}');
const trace = path.join(root, 'adapter-events.jsonl'); const hold = path.join(root, 'hold-preparation');
fs.writeFileSync(hold, 'controlled pause');
fs.writeFileSync(path.join(installed, 'logic.js'), `import fs from 'node:fs';
export class Adapter { systemId='fixture'; match(){return true}
 constructor(){fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({event:'constructed',pid:process.pid})+'\\n')}
 async initialize(){fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({event:'initialize',pid:process.pid})+'\\n');
 while(fs.existsSync(${JSON.stringify(hold)})) await new Promise(resolve=>setTimeout(resolve,50));}
 normalizeActorData(actor){return {...actor,id:actor._id,img:'',derived:{fixed:actor.system.fixed}}} }`);
const logFile = path.join(root, 'manager.log'); const log = fs.openSync(logFile, 'a');
const manager = spawn(process.execPath, ['--import', 'tsx', 'src/scripts/start-server.ts', 'dev', `--data-dir=${data}`],
    { cwd: workspace, env: { ...env, SHEET_DELVER_DATA: data }, stdio: ['ignore', log, log] });
const origin = `http://127.0.0.1:${appPort}`; const api = `http://127.0.0.1:${apiPort}`;
let cookie = ''; let csrf = '';
async function request(url: string, body?: unknown) {
    return fetch(`${api}${url}`, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(3000),
        headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-Admin-Csrf-Token': csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function until<T>(label: string, operation: () => Promise<T | false>, timeout = 90_000): Promise<T> {
    const end = Date.now() + timeout;
    while (Date.now() < end) { try { const result = await operation(); if (result !== false) return result; } catch { /* startup/replacement expected */ }
        if (manager.exitCode !== null) throw new Error(`Manager exited: ${manager.exitCode}`);
        await new Promise(resolve => setTimeout(resolve, 200)); }
    throw new Error(`Timed out: ${label}; inspect ${logFile}`);
}
try {
    await until('Core admin ready', async () => (await request('/admin/auth/status')).ok || false);
    const login = await request('/admin/auth/login', { password: 'isolated-acceptance-password' }); assert.equal(login.status, 200);
    cookie = login.headers.getSetCookie()[0].split(';')[0]; csrf = (await login.json()).csrfToken;
    await until('compatibility gate', async () => (await (await request('/admin/module-upgrades')).json()).compatibilityDiagnostic || false);
    assert.equal(fs.existsSync(trace), false, 'no candidate adapter constructed before source compatibility');
    assert.equal((await request('/api/actors')).status, 503);
    const before = fs.readFileSync(logFile, 'utf8');
    const initialPids = [...before.matchAll(/(?:Core Service spawned|Application Shell spawned) \(pid=(\d+)\)/g)].map(row => Number(row[1]));
    assert.equal(initialPids.length, 2);
    const previewResponse = await request('/admin/module-upgrades/source/fixture/preview', { source: 'managed' });
    assert.equal(previewResponse.status, 200); const preview = await previewResponse.json();
    const approved = await request('/admin/module-upgrades/source/apply', { planId: preview.id, backupAcknowledged: true });
    assert.equal(approved.status, 202); const { jobId } = await approved.json();
    const jobFile = path.join(data, 'config/module-upgrades/jobs', `${jobId}.json`);
    assert.equal(JSON.parse(fs.readFileSync(jobFile, 'utf8')).phase, 'restarting');
    await until('real replacement into preparation', async () => fs.existsSync(trace) && JSON.parse(fs.readFileSync(jobFile, 'utf8')).phase === 'verifying' || false);
    assert.equal(writes, 1); assert.equal((await request('/admin/module-upgrades')).status, 200, 'admin session survives supervised restart');
    assert.equal((await request('/api/actors')).status, 503, 'replacement does not serve before adapter preparation');
    const pending = JSON.parse(fs.readFileSync(jobFile, 'utf8')); assert.ok(pending.leaseToken); assert.equal(pending.possibleWrite, true);
    fs.unlinkSync(hold);
    await until('completed activation', async () => JSON.parse(fs.readFileSync(jobFile, 'utf8')).phase === 'completed' || false);
    const publicStatus = await (await request('/api/status')).json(); assert.equal(publicStatus.initialized, true); assert.equal(publicStatus.runtimeToken, jobId);
    assert.equal((await request('/api/actors', {})).status, 409, 'old browser without first runtime token cannot mutate');
    const after = fs.readFileSync(logFile, 'utf8');
    const replacedPids = [...after.matchAll(/(?:Core Service spawned|Application Shell spawned) \(pid=(\d+)\)/g)].map(row => Number(row[1]));
    assert.equal(replacedPids.length, 4); assert.ok(replacedPids[2] !== initialPids[0] && replacedPids[3] !== initialPids[1]);
    assert.match(after, /Full-stack restart requested/);
    const actualCorePids = [...after.matchAll(/Core Service \| Started \(pid=(\d+)/g)].map(row => Number(row[1]));
    assert.equal(actualCorePids.length, 2); assert.notEqual(actualCorePids[0], actualCorePids[1]);
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ manager: manager.pid, initialPids, replacementPids: replacedPids.slice(2), actualCorePids, appPort, apiPort,
        upstreamPort, jobId, phases: ['restarting', 'verifying', 'completed'], pendingLeaseObserved: true, admissionBeforeConstruction: true,
        adminDuringPreparation: 200, playerDuringPreparation: 503, staleMutationAfterActivation: 409,
        writes, adapter: fs.readFileSync(trace, 'utf8'), native: false }, null, 2));
    console.log(`PASS: actual manager/Core/Next replacement, durable lease/job, pre-adapter admission, admin continuity and first-token fence. Evidence: ${root}`);
} finally {
    if (manager.exitCode === null) manager.kill('SIGTERM');
    await Promise.race([new Promise(resolve => manager.once('close', resolve)), new Promise(resolve => setTimeout(resolve, 15_000))]);
    sockets.close(); await new Promise<void>(resolve => wire.close(() => resolve())); fs.closeSync(log);
}
