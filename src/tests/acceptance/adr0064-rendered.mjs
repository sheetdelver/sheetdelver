/** Isolated actual-component rendering. Browser tooling stays outside runtime dependencies. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

if (!process.env.SD_PLAYWRIGHT_MODULE) throw new Error('Set SD_PLAYWRIGHT_MODULE to the existing isolated Playwright entry; no dependency installation is performed');
const { chromium } = await import(process.env.SD_PLAYWRIGHT_MODULE);
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-cr64-rendered-'));
const bundle = await build({ stdin: { contents: `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { AdminAuthProvider } from './src/app/(admin)/context/AdminAuthContext';
import { AdminRuntimeRestartProvider } from './src/app/(admin)/context/AdminRuntimeRestartContext';
import SourceMigrationReview from './src/app/(admin)/components/SourceMigrationReview';
import ModuleUpgradeStatus from './src/app/(admin)/components/ModuleUpgradeStatus';
function App(){return <div className="admin-shell min-h-screen bg-[var(--admin-bg)] p-3" data-admin-theme={window.fixture.theme}>
<AdminAuthProvider><AdminRuntimeRestartProvider><SourceMigrationReview moduleId="fixture" source="managed" onSessionExpired={()=>window.fixture.expired++}/><ModuleUpgradeStatus/></AdminRuntimeRestartProvider></AdminAuthProvider></div>}
createRoot(document.getElementById('root')).render(<App/>);
`, resolveDir: process.cwd(), sourcefile: 'adr0064-rendered-fixture.tsx', loader: 'tsx' }, bundle: true, write: false,
    platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
// Actual Core stylesheet/variables and Tailwind utilities, without scanning any module repository.
const css = await postcss([tailwind({ base: process.cwd() })]).process(fs.readFileSync('src/app/globals.css', 'utf8')
    .replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "./(admin)";\n@source "../client/ui/components";'), { from: path.resolve('src/app/globals.css') });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--disable-background-networking'] });
let jobs = [{ jobId: 'job', moduleId: 'fixture', phase: 'recovery-required', candidateVersion: '1.0.0', possibleWrite: true, outcomes: { a: { state: 'confirmed' } } }];
const preview = { id: 'exact-plan', artifactDigest: 'sha256:' + 'a'.repeat(64), candidateVersion: '1.0.0', expiresAt: Date.now() + 900_000,
    plan: { world: { identity: { worldId: 'controlled-world', systemVersion: '1.0.0' } }, checked: 1, blockers: [],
        exclusions: ['Package packs excluded'], operations: [{ stepId: 'fix', uuid: 'Actor.a', updates: { 'system.fixed': true } }] } };
let expired = false; const requests = [];
const errors = [];
try {
    for (const width of [320, 390, 820, 1440]) for (const theme of ['light', 'dark']) {
        const page = await browser.newPage({ viewport: { width, height: 900 } }); page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', async route => {
            const request = route.request(); const url = new URL(request.url());
            assert.equal(url.hostname, '127.0.0.1', 'no external browser requests'); requests.push(url.pathname);
            if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<html><head><style>${css.css}</style></head><body><div id="root"></div><script>window.fixture={theme:${JSON.stringify(theme)},expired:0}</script><script>${bundle.outputFiles[0].text}</script></body></html>` });
            if (url.pathname.endsWith('/auth/me')) return route.fulfill({ json: { adminId: 'admin', csrfToken: 'csrf' } });
            if (url.pathname.endsWith('/auth/status')) return route.fulfill({ json: { accountExists: true } });
            if (url.pathname.endsWith('/auth/logout')) return route.fulfill({ json: { success: true } });
            if (expired) return route.fulfill({ status: 401, json: { error: 'expired' } });
            if (url.pathname.endsWith('/module-upgrades')) return route.fulfill({ json: { jobs, serviceAccountDiagnostic: null, compatibilityDiagnostic: { moduleId: 'fixture', phase: 'source-check', blockers: ['Controlled source requires maintenance'], remediation: 'Preview exact world repair.' } } });
            if (url.pathname.endsWith('/preview') || url.pathname.endsWith('/review')) return route.fulfill({ json: preview });
            if (url.pathname.endsWith('/cancel')) { jobs[0].phase = 'recovery-required'; return route.fulfill({ json: jobs[0] }); }
            if (url.pathname.endsWith('/cleanup')) { jobs[0].retainedFiles = 'cleaned'; return route.fulfill({ json: jobs[0] }); }
            return route.fulfill({ json: { accepted: true } });
        });
        await page.goto('http://127.0.0.1:31998/');
        await page.getByText('World data checks / same-version repair (managed)').click();
        await page.getByRole('button', { name: 'Preview world maintenance' }).click();
        await page.getByRole('region', { name: 'Module upgrade status' }).waitFor();
        await page.getByText('Proposed source paths', { exact: true }).click();
        await page.getByText('fix: Actor.a: system.fixed', { exact: true }).waitFor();
        assert.ok(await page.getByText('Excluded/advisory: Package packs excluded').isVisible());
        assert.equal(await page.getByRole('button', { name: 'Approve maintenance and restart' }).isEnabled(), false);
        await page.getByRole('checkbox').check();
        assert.equal(await page.getByRole('button', { name: 'Approve maintenance and restart' }).isEnabled(), true);
        await page.getByRole('button', { name: 'Review changed source' }).click();
        const dialog = page.getByRole('dialog', { name: 'Fresh recovery approval' }); await dialog.waitFor();
        assert.ok(await dialog.getByText('World: controlled-world; native system 1.0.0.').isVisible());
        await dialog.getByText('Proposed source paths', { exact: true }).click();
        await dialog.getByText('fix: Actor.a: system.fixed', { exact: true }).waitFor();
        for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
        assert.ok(await page.evaluate(() => document.querySelector('dialog[open]')?.contains(document.activeElement)), 'modal focus is confined');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${theme}/${width}: no horizontal overflow`);
        const bounds = await dialog.boundingBox(); assert.equal(bounds.y, 0); assert.ok(bounds.width <= width);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(output, `recovery-${theme}-${width}.png`), fullPage: true });
        await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 0);
        assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Review changed source');
        await page.getByRole('button', { name: 'Stop further writes' }).click();
        await page.getByRole('dialog', { name: 'Stop module upgrade?' }).waitFor();
        await page.getByRole('button', { name: 'Keep running' }).click();
        if (width === 1440 && theme === 'dark') {
            await page.reload();
            await page.getByText('1 confirmed target writes.', { exact: true }).waitFor();
            jobs[0] = { ...jobs[0], phase: 'completed' };
            await page.getByRole('button', { name: 'Refresh status' }).click();
            await page.getByRole('button', { name: 'Clean retained package files' }).click();
            await page.getByRole('dialog', { name: 'Clean retained package files?' }).waitFor();
            await page.getByRole('button', { name: 'Confirm cleanup' }).click();
            expired = true;
            await page.getByText('World data checks / same-version repair (managed)').click();
            await page.getByRole('button', { name: 'Preview world maintenance' }).click();
            await page.waitForFunction(() => window.fixture.expired === 1);
        }
        await page.close();
    }
    assert.deepEqual(errors, []); assert.ok(requests.some(url => url.endsWith('/cleanup')));
    console.log(`PASS: actual admin components, 320/390/820/1440, light/dark, exact plan detail, auth expiry, keyboard/focus, stop/cleanup. Screenshots: ${output}`);
} finally { await browser.close(); }
