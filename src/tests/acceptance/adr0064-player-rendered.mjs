/** Actual realtime/boundary components with a controlled browser socket, no servers. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
if (!process.env.SD_PLAYWRIGHT_MODULE) throw new Error('Existing isolated SD_PLAYWRIGHT_MODULE required');
const { chromium } = await import(process.env.SD_PLAYWRIGHT_MODULE);
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-cr64-player-rendered-'));
const stubs = new Map([
    ['@client/ui/context/SessionContext', `export const COOKIE_SESSION_MARKER='marker'; const state={token:'marker',currentUserId:'player',sessionEpoch:1,setCurrentUserId(){},setToken(){},invalidateLocalSession(){},isExplicitLogoutPending(){return false}}; export const useSession=()=>state;`],
    ['@client/ui/context/FoundryContext', `export const useFoundry=()=>({step:'dashboard',worldId:'w1',system:{status:'active'},users:[],handleLogin(){}});`],
    ['@client/ui/context/UIContext', `export const useUI=()=>({resetUI(){}});`],
    ['@client/ui/main/components/LoadingScreen', 'export const LoadingScreen=()=>null;'],
    ['@client/ui/main/views/LoginView', 'export const LoginView=()=>null;'],
    ['@client/ui/main/views/SetupView', 'export const SetupView=()=>null;'],
    ['@client/ui/main/views/WorldClosedView', 'export const WorldClosedView=()=>null;'],
    ['socket.io-client', `export function io(){const events=new Map(); const socket={connected:true,active:true,io:{on(){}},on(key,callback){events.set(key,callback);return socket},disconnect(){socket.connected=false;events.get('disconnect')?.();return socket},connect(){socket.connected=true;events.get('connect')?.();return socket}};window.fixture.socket=socket;window.fixture.emit=(key,value)=>events.get(key)?.(value);queueMicrotask(()=>{events.get('connect')?.();events.get('systemStatus')?.(window.fixture.status)});return socket;}`],
]);
const bundle = await build({ stdin: { contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {RealtimeProvider} from './src/client/ui/context/RealtimeContext';
import {PlayerWorldBoundary} from './src/client/ui/components/PlayerWorldBoundary';
import {PlayerAppearanceProvider,PLAYER_APPEARANCE_KEY} from './src/client/ui/context/PlayerAppearanceContext';
localStorage.setItem(PLAYER_APPEARANCE_KEY,window.fixture.appearance);
createRoot(document.getElementById('root')).render(<PlayerAppearanceProvider><RealtimeProvider><PlayerWorldBoundary><button id="actor-action" onClick={()=>window.fixture.writes++}>Actor action</button></PlayerWorldBoundary></RealtimeProvider></PlayerAppearanceProvider>);
`, resolveDir: process.cwd(), sourcefile: 'adr0064-player-fixture.tsx', loader: 'tsx' }, bundle: true, write: false, metafile: true,
    platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'controlled-boundaries', setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: 'controlled' } : undefined);
        builder.onLoad({ filter: /.*/, namespace: 'controlled' }, args => ({ contents: stubs.get(args.path), loader: 'js' }));
    } }] });
assert.ok(!Object.keys(bundle.metafile.inputs).some(file => file.includes('data/local/modules')), 'no module repository inspected or bundled');
const css = await postcss([tailwind({ base: process.cwd() })]).process(fs.readFileSync('src/app/globals.css', 'utf8')
    .replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "../client/ui/components";\n@source "../client/ui/context";'), { from: path.resolve('src/app/globals.css') });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
let runtime = null; let documents = 0;
const appearances = [];
const expected = {
    light: { panel: 'rgba(250,253,255,0.98)', text: 'rgb(23,40,60)', backdrop: 'rgba(14,29,47,0.55)' },
    dark: { panel: 'rgba(28,48,72,0.97)', text: 'rgb(241,245,251)', backdrop: 'rgba(3,12,24,0.72)' },
};
try {
    for (const width of [320, 390, 820, 1440]) for (const theme of ['light', 'dark']) {
        const page = await browser.newPage({ viewport: { width, height: 900 } }); const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', async route => {
            const url = new URL(route.request().url()); assert.equal(url.hostname, '127.0.0.1');
            if (url.pathname === '/') { documents++; return route.fulfill({ contentType: 'text/html', body: `<html><head><style>${css.css}</style></head><body><div id="root"></div><script>window.fixture={appearance:${JSON.stringify(theme)},writes:0,status:{worldId:'w1',connected:true,initialized:true,runtimeToken:${JSON.stringify(runtime)},system:{status:'active'}}}</script><script>${bundle.outputFiles[0].text}</script></body></html>` }); }
            if (url.pathname === '/api/session/users') return route.fulfill({ json: { users: [], currentUserId: 'player' } });
            return route.abort();
        });
        await page.goto('http://127.0.0.1:31997/');
        await page.locator('#actor-action').waitFor(); await page.locator('#actor-action').click();
        await page.evaluate(() => window.fixture.emit('systemStatus', { ...window.fixture.status, initialized: false,
            maintenance: { phase: 'migrating', message: 'Module upgrade in progress' } }));
        await page.getByText('Module upgrade in progress', { exact: true }).waitFor();
        await page.locator(`.sd-player-root[data-sd-appearance="${theme}"]`).waitFor();
        assert.equal(await page.locator('body').getAttribute('data-sd-appearance'), theme);
        assert.equal(await page.locator('html').getAttribute('data-sd-appearance'), theme);
        const appearance = await page.locator('.sd-ui-panel-raised').evaluate(element => {
            const style = getComputedStyle(element);
            return Object.fromEntries(['--sd-ui-surface-raised', '--sd-ui-text', '--sd-ui-backdrop'].map(key => [key, style.getPropertyValue(key).trim()]));
        });
        for (const [key, value] of Object.entries(appearance)) assert.ok(value, `${width}/${theme}: ${key} must resolve from an active player appearance scope`);
        const resolved = await page.evaluate(() => {
            const panel = getComputedStyle(document.querySelector('.sd-ui-panel-raised'));
            const overlay = getComputedStyle(document.querySelector('.sd-ui-overlay'));
            return { panel: panel.backgroundColor, text: panel.color, backdrop: overlay.backgroundColor };
        });
        for (const [key, value] of Object.entries(expected[theme])) assert.equal(resolved[key].replace(/\s+/g, ''), value, `${width}/${theme}: resolved ${key}`);
        appearances.push({ width, theme, tokens: appearance, resolved });
        assert.equal(await page.locator('#actor-action').evaluate(element => element.closest('[inert]') !== null), true);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
        assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'actor-action', 'keyboard cannot reach an inert actor action');
        await page.mouse.click(width / 2, 200);
        assert.ok(await page.getByText('Module upgrade in progress', { exact: true }).isVisible(), 'player cannot dismiss server maintenance');
        assert.equal(await page.evaluate(() => window.fixture.writes), 1);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.screenshot({ path: path.join(output, `maintenance-${theme}-${width}.png`) });
        if (width === 1440 && theme === 'dark') {
            // Missed serverRestarting: reconnect status alone must replace old assets.
            const before = documents; runtime = 'first-approved-upgrade';
            await page.evaluate(() => { window.fixture.socket.disconnect(); window.fixture.socket.connect();
                window.fixture.emit('systemStatus', { ...window.fixture.status, runtimeToken: 'first-approved-upgrade' }); });
            await page.waitForLoadState('load');
            await page.waitForFunction(() => window.fixture.status.runtimeToken === 'first-approved-upgrade');
            assert.equal(documents, before + 1, 'null-to-first token causes exactly one actual browser reload');
            await page.locator('#actor-action').waitFor();
            assert.equal(await page.locator('body').getAttribute('data-sd-appearance'), theme, 'appearance owner survives actual asset reload');
            await page.evaluate(() => window.fixture.emit('systemStatus', window.fixture.status));
            assert.equal(documents, before + 1, 'replacement assets do not loop');
        }
        assert.deepEqual(errors, []); await page.close();
    }
    for (const width of [320, 390, 820, 1440]) assert.notDeepEqual(appearances.find(row => row.width === width && row.theme === 'light').resolved,
        appearances.find(row => row.width === width && row.theme === 'dark').resolved, `${width}: light and dark must differ`);
    fs.writeFileSync(path.join(output, 'appearance-evidence.json'), JSON.stringify(appearances, null, 2));
    console.log(`PASS: actual appearance owner and computed distinct light/dark styles, player boundary/realtime, nondismissible maintenance, keyboard/inert actions, first-upgrade missed-restart reload; 8 viewport/theme cases. Evidence: ${output}`);
} finally { await browser.close(); }
