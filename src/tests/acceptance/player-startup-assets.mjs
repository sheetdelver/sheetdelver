/**
 * Actual player providers, Socket.IO and module asset route on isolated loopback.
 * Browser HTTP caching stays enabled. No Foundry/configuration/session is reused.
 * Run: SD_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --import tsx <this-file>
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

if (!process.env.SD_PLAYWRIGHT_MODULE) throw new Error('An existing isolated Playwright installation is required');
const { chromium } = await import(process.env.SD_PLAYWRIGHT_MODULE);
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-startup-assets-'));
process.env.SHEET_DELVER_DATA = path.join(output, 'data');
const { initDataDir } = await import('../../server/core/paths.ts');
initDataDir(process.env.SHEET_DELVER_DATA);
const { createModuleRouter } = await import('../../server/routes/modules/createModuleRouter.ts');
const stubs = new Map([
    ['@client/ui/main/views/LoginView', 'export const LoginView=()=>null;'],
    ['@client/ui/main/views/SetupView', 'export const SetupView=()=>null;'],
    ['@client/ui/main/views/WorldClosedView', 'export const WorldClosedView=()=>null;'],
    ['next/navigation', 'export const usePathname=()=>window.location.pathname;'],
    ['@client/ui/context/UIContext', 'const ui={resetUI(){},isChatOpen:false};export const useUI=()=>ui;'],
    ['./UIContext', 'const ui={resetUI(){},isChatOpen:false};export const useUI=()=>ui;'],
    ['@client/ui/components/NotificationSystem', 'const notifications={addNotification(){}};export const useNotifications=()=>notifications;'],
    ['./DicePresentationContext', 'const dice={heldMessageIds:new Set(),recordCreated(){},prepareMessages(){},invalidateMessage(){},resetPresentation(){}};export const useDicePresentation=()=>dice;'],
    ['@client/ui/hooks/useModuleHotReload', 'export const useModuleHotReload=()=>null;'],
    ['@client/ui/sdk/createClientDocumentSource', 'export const resetClientDocumentSource=()=>{};'],
]);
const bundle = await build({
    stdin: { contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {SessionProvider,useSession} from './src/client/ui/context/SessionContext';
import {RealtimeProvider,useRealtime} from './src/client/ui/context/RealtimeContext';
import {ActorCombatProvider} from './src/client/ui/context/ActorCombatContext';
import {ChatProvider} from './src/client/ui/context/ChatContext';
import {FoundryProvider,useFoundry} from './src/client/ui/context/FoundryContext';
import {PlayerWorldBoundary} from './src/client/ui/components/PlayerWorldBoundary';
import {PlayerAppearanceProvider} from './src/client/ui/context/PlayerAppearanceContext';
function Probe(){const s=useSession(),r=useRealtime(),f=useFoundry();
 window.probe={step:s.step,link:r.linkState,token:s.token,user:s.currentUserId,world:f.worldId,
 disconnect:()=>r.appSocket.disconnect(),connect:()=>r.appSocket.connect(),
 login:()=>s.handleLogin('player'),logout:()=>s.handleLogout()};
 return <output id="state">{s.step+':'+r.linkState}</output>}
const providers=<SessionProvider><RealtimeProvider><ActorCombatProvider><ChatProvider><FoundryProvider><Probe/><PlayerAppearanceProvider><PlayerWorldBoundary><button id="world-action">World action</button></PlayerWorldBoundary></PlayerAppearanceProvider></FoundryProvider></ChatProvider></ActorCombatProvider></RealtimeProvider></SessionProvider>;
createRoot(document.getElementById('root')).render(location.search.includes('strict=1')?<React.StrictMode>{providers}</React.StrictMode>:providers);
`, resolveDir: process.cwd(), sourcefile: 'startup-fixture.tsx', loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'peripheral-ui-only', setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: 'fixture' } : undefined);
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs.get(args.path), loader: 'js' }));
    } }],
});
const styleStubs = new Map([
    ['@data-registry/module-ui-registry', `const load=async()=>({default:{info:{id:'fixture'},stylesheet:'assets/theme.css'}});export const localModuleUIs={fixture:load};export const dataModuleUIs={fixture:load};`],
    ['@client/ui/components/GenericSheet', 'export default function GenericSheet(){return null}'],
    ['@client/ui/pages/GenericActorPage', 'export default function GenericActorPage(){return null}'],
]);
const stylesBundle = await build({
    stdin: { contents: `
import {getUIModule,invalidateModuleSourceCache} from './src/modules/registry/core/client';
window.refreshStyles=async()=>{invalidateModuleSourceCache();await getUIModule('fixture');};
window.refreshStyles();
`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, platform: 'browser', format: 'iife',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'fixture-module-registry', setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => styleStubs.has(args.path) ? { path: args.path, namespace: 'fixture' } : undefined);
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: styleStubs.get(args.path), loader: 'js' }));
    } }],
});
const css = await postcss([tailwind({ base: process.cwd() })]).process(fs.readFileSync('src/app/globals.css', 'utf8')
    .replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "../client/ui/components";\n@source "../client/ui/context";\n@source "../client/ui/main/components";'), { from: path.resolve('src/app/globals.css') });
const app = express(), server = http.createServer(app), io = new Server(server);
const counts = {}, sockets = new Set(), results = [];
let connections = 0, authorized = true, source = 'local', publicFirst = false;
let serveLegacyCachedCss = false;
const status = { connected: true, initialized: true, worldId: 'fixture-world', runtimeToken: null,
    system: { id: 'generic', status: 'active', worldTitle: 'Fixture' },
    users: [{ _id: 'player', name: 'Player', role: 1 }], isConfigured: true };
const publicStatus = () => { const { worldId, ...rest } = status; return rest; };
io.on('connection', socket => {
    connections++; sockets.add(socket);
    socket.on('disconnect', () => sockets.delete(socket));
    socket.emit('systemStatus', authorized && !publicFirst ? status : publicStatus());
    publicFirst = false;
});
app.use((req, _res, next) => { counts[req.path] = (counts[req.path] || 0) + 1; next(); });
app.get('/', (_req, res) => res.set('Cache-Control', 'no-store').type('html').send(
    `<style>${css.css}</style><div id="root"></div><script>${bundle.outputFiles[0].text}</script>`));
app.get('/api/session/users', (_req, res) => {
    if (!authorized) return res.status(401).json({ error: 'Unauthenticated' });
    if (!status.initialized) return res.status(503).json({ error: 'World unavailable' });
    res.set('Cache-Control', 'no-store').json({ currentUserId: 'player', users: status.users });
});
app.post('/api/login', (_req, res) => { authorized = true; res.json({ success: true }); });
app.post('/api/logout', (_req, res) => {
    authorized = false; io.emit('sessionInvalidated', { reason: 'logout' }); io.emit('systemStatus', publicStatus());
    res.json({ success: true });
});
app.get('/api/actors', (_req, res) => res.json({ ownedActors: [], readOnlyActors: [], actorCards: {} }));
app.get('/api/combats', (_req, res) => res.json({ combats: [] }));
app.get('/api/chat', (_req, res) => res.json({ messages: [] }));
app.get('/api/shared-content', (_req, res) => res.json({ shares: [] }));
app.get('/api/registry/sources', (_req, res) => res.set('Cache-Control', 'no-store').json({ fixture: source }));
const cssFile = which => path.join(process.env.SHEET_DELVER_DATA, which === 'local' ? 'local/modules' : 'modules', 'fixture/assets/theme.css');
for (const which of ['local', 'managed']) {
    fs.mkdirSync(path.dirname(cssFile(which)), { recursive: true });
    fs.writeFileSync(cssFile(which), `#sample{width:${which === 'local' ? 111 : 222}px}`);
}
app.get('/api/modules/fixture/assets/theme.css', (_req, res, next) => {
    if (!serveLegacyCachedCss) return next();
    res.set('Cache-Control', 'public,max-age=3600').type('css').send('#sample{width:77px}');
});
app.use('/api/modules', createModuleRouter({ tryAuthenticateSession: (_req, _res, next) => next(), getModuleAssetSource: () => source }));
app.get('/styles', (req, res) => res.set('Cache-Control', 'no-store').type('html').send(
    `${req.query.legacy ? '<link rel="stylesheet" href="/api/modules/fixture/assets/theme.css">' : `<script>${stylesBundle.outputFiles[0].text}</script>`}<div id="sample">Style sample</div>`));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.SD_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
const check = async (name, fn) => {
    try { await fn(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
};
try {
    const page = await browser.newPage();
    page.setDefaultTimeout(2500);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await check('cold restoration uses one socket and becomes ready without another heartbeat', async () => {
        const started = Date.now();
        await page.goto(origin);
        await page.waitForFunction(() => window.probe?.step === 'dashboard' && window.probe?.link === 'ready', undefined, { timeout: 1800 });
        assert.equal(connections, 1);
        results.push({ name: 'cold-ready-ms', value: Date.now() - started });
    });
    // Permit the uncorrected version to continue, so duplicate reads are measured independently.
    for (let i = 0; i < 3; i++) { io.emit('systemStatus', status); await page.waitForTimeout(100); }
    await check('one initial actors/combat/chat read', async () => {
        for (const endpoint of ['/api/session/users', '/api/actors', '/api/combats', '/api/chat']) assert.equal(counts[endpoint], 1, endpoint);
    });
    await check('healthy heartbeats do not reconnect or refetch', async () => {
        const before = JSON.stringify(counts), opened = connections;
        for (let i = 0; i < 20; i++) io.emit('systemStatus', status);
        await page.waitForTimeout(150);
        assert.equal(connections, opened); assert.equal(JSON.stringify(counts), before);
    });
    await check('transport recovery verifies once and refreshes each collection once', async () => {
        const before = { ...counts }, opened = connections;
        await page.evaluate(() => window.probe.disconnect());
        await page.waitForFunction(() => window.probe.link === 'disconnected');
        await page.evaluate(() => window.probe.connect());
        await page.waitForFunction(() => window.probe.link === 'ready');
        await page.waitForTimeout(150);
        assert.equal(connections, opened + 1);
        for (const endpoint of ['/api/session/users', '/api/actors', '/api/combats', '/api/chat']) assert.equal(counts[endpoint] - before[endpoint], 1, endpoint);
    });
    await check('logout and subsequent login keep authority separate', async () => {
        await page.evaluate(() => window.probe.logout());
        await page.waitForFunction(() => window.probe.link === 'guest' && !window.probe.token)
            .catch(async error => { throw new Error(`Logout: ${JSON.stringify(await page.evaluate(() => window.probe))}; ${error.message}`); });
        const before = counts['/api/actors'];
        io.emit('systemStatus', publicStatus()); await page.waitForTimeout(100);
        assert.equal(counts['/api/actors'], before);
        await page.evaluate(() => window.probe.login());
        await page.waitForFunction(() => window.probe?.link === 'ready' && window.probe?.step === 'dashboard')
            .catch(async error => { throw new Error(`Login: ${JSON.stringify(await page.evaluate(() => window.probe))}; ${error.message}`); });
    });
    await check('public admission followed by restored cookie rehandshakes only once', async () => {
        publicFirst = true; const opened = connections;
        await page.reload();
        await page.waitForFunction(() => window.probe?.link === 'ready' && window.probe?.step === 'dashboard');
        assert.equal(connections - opened, 2);
    });
    await check('repeated page loads including Strict Mode each restore once', async () => {
        for (let i = 0; i < 3; i++) {
            const before = { ...counts }, opened = connections;
            await page.goto(`${origin}/?strict=${i % 2}`);
            await page.waitForFunction(() => window.probe?.link === 'ready' && window.probe?.step === 'dashboard');
            await page.waitForTimeout(100);
            assert.equal(connections - opened, 1);
            for (const endpoint of ['/api/session/users', '/api/actors', '/api/combats', '/api/chat']) assert.equal(counts[endpoint] - before[endpoint], 1, endpoint);
        }
    });
    await check('protected 401 retires loaded authority', async () => {
        authorized = false;
        await page.evaluate(() => { window.probe.disconnect(); window.probe.connect(); });
        await page.waitForFunction(() => window.probe.link === 'guest' && !window.probe.token);
    });
    await check('no browser exceptions', async () => assert.deepEqual(errors, []));
    await page.close();

    authorized = true;
    const blocked = await browser.newPage();
    const blockedErrors = []; blocked.on('pageerror', error => blockedErrors.push(error.message));
    status.initialized = false; status.system.status = 'startup';
    status.maintenance = { phase: 'initializing', message: 'internal detail' };
    await blocked.goto(origin);
    await blocked.getByRole('heading', { name: 'World Starting...' }).waitFor();
    await check('cold startup failure replaces the spinner with a private static notice', async () => {
        status.system.status = 'unavailable';
        status.maintenance = { phase: 'blocked', message: 'Scene.private.Token.secret' };
        const reads = counts['/api/actors'];
        io.emit('systemStatus', status);
        await blocked.getByRole('heading', { name: 'SheetDelver is in maintenance', exact: true }).waitFor();
        assert.equal(await blocked.locator('.animate-spin').count(), 0);
        assert.equal(await blocked.locator('#world-action').count(), 0);
        assert.equal((await blocked.locator('body').innerText()).includes('Scene.private'), false);
        assert.equal(counts['/api/actors'], reads);
    });
    await check('cold failed status renders at four widths in both appearances', async () => {
        for (const width of [360, 768, 1024, 1440]) for (const theme of ['light', 'dark']) {
            await blocked.setViewportSize({ width, height: 900 });
            await blocked.evaluate(theme => localStorage.setItem('sheetdelver-player-appearance', theme), theme);
            await blocked.reload();
            const notice = blocked.getByRole('heading', { name: 'SheetDelver is in maintenance', exact: true });
            await notice.waitFor();
            const rect = await notice.boundingBox(); assert.ok(rect.x >= 0 && rect.x + rect.width <= width);
            assert.equal(await blocked.locator('.animate-spin').count(), 0);
            assert.equal(await blocked.locator('input,form').count(), 0, 'no client admin/login form');
            await blocked.screenshot({ path: path.join(output, `failed-${width}-${theme}.png`) });
        }
    });
    await check('generic bootstrap failure is unavailable without claiming maintenance', async () => {
        status.maintenance = null; io.emit('systemStatus', status);
        await blocked.getByRole('heading', { name: 'SheetDelver is unavailable', exact: true }).waitFor();
        assert.equal(await blocked.locator('.animate-spin').count(), 0);
    });
    await check('successful retry restores the same browser through protected readiness', async () => {
        status.system.status = 'active'; status.initialized = true;
        io.emit('systemStatus', status);
        // Normal protected-session retry is rate limited to five seconds.
        await blocked.waitForTimeout(5100); io.emit('systemStatus', status);
        await blocked.locator('#world-action').waitFor();
        assert.equal(await blocked.getByRole('alert').count(), 0);
        status.system.status = 'unavailable'; status.initialized = false;
        status.maintenance = { phase: 'blocked', message: 'private-source' }; io.emit('systemStatus', status);
        await blocked.getByRole('heading', { name: 'SheetDelver is in maintenance', exact: true }).waitFor();
        assert.equal(await blocked.locator('#world-action').evaluate(el => Boolean(el.closest('[inert]'))), true);
        assert.equal(await blocked.locator('.animate-spin').count(), 0, 'warm failure also stops spinning');
        assert.deepEqual(blockedErrors, []);
    });
    await blocked.close();

    const styles = await browser.newPage();
    const width = () => styles.locator('#sample').evaluate(el => getComputedStyle(el).width);
    const expectWidth = expected => styles.waitForFunction(value => getComputedStyle(document.querySelector('#sample')).width === value, expected, { timeout: 1500 });
    await check('new client bypasses the previously hour-cached CSS URL', async () => {
        serveLegacyCachedCss = true;
        await styles.goto(`${origin}/styles?legacy=1`); assert.equal(await width(), '77px');
        serveLegacyCachedCss = false;
        await styles.goto(`${origin}/styles`); await expectWidth('111px');
    });
    await check('warm cached stylesheet changes on ordinary navigation', async () => {
        await styles.goto(`${origin}/styles`); await expectWidth('111px');
        fs.writeFileSync(cssFile('local'), '#sample{width:3333px}');
        // Ordinary navigation, not cache-disabled interception or force reload.
        await styles.goto(`${origin}/styles`);
        await expectWidth('3333px');
    });
    await check('source switch selects the current managed stylesheet', async () => {
        source = 'managed'; await styles.evaluate(() => window.refreshStyles()); await expectWidth('222px');
    });
    await styles.close();
} finally {
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    await browser.close(); await new Promise(resolve => io.close(resolve)); await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify({ output, results }, null, 2));
if (results.some(result => result.passed === false)) process.exitCode = 1;
