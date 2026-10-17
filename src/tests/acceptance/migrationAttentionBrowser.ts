/** Browser checks against the actual isolated supervisor/Core/Next, not mocked routes. */
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

export async function inspectMigrationAttention(origin: string, cookie: string, root: string, quiet = false) {
    if (!process.env.SD_PLAYWRIGHT_MODULE) throw new Error('Migration attention acceptance requires isolated browser tooling');
    const { chromium } = await import(process.env.SD_PLAYWRIGHT_MODULE);
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
    const errors: string[] = []; const styles: Record<string, string> = {}; const requests: string[] = [];
    try {
        for (const width of [320, 390, 820, 1440]) for (const theme of ['light', 'dark'] as const) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
            const [name, ...value] = cookie.split('='); await context.addCookies([{ name, value: value.join('='), url: origin, httpOnly: true }]);
            await context.addInitScript((theme: string) => localStorage.setItem('admin-theme', theme), theme);
            const page = await context.newPage(); page.on('pageerror', (error: Error) => errors.push(error.message));
            page.on('request', (request: { url(): string; method(): string }) => { const url = new URL(request.url()); if (request.method() === 'POST') requests.push(url.pathname); });
            if (quiet) {
                await page.goto(`${origin}/admin/modules`);
                const installed = page.getByRole('region', { name: 'Current world migration status' });
                await page.waitForFunction(() => document.querySelector('[data-installed-migration-state]')?.getAttribute('data-installed-migration-state') === 'up-to-date');
                assert.equal(await installed.locator(':scope > details').evaluate((element: HTMLDetailsElement) => element.open), false);
                assert.ok(await page.locator('details[data-migration-state]').evaluateAll((elements: HTMLDetailsElement[]) => elements.every(element => !element.open)));
                assert.equal(await page.getByRole('region', { name: 'Migration attention', exact: true }).count(), 0, 'Installed does not duplicate global chrome');
                assert.equal(await page.getByRole('region', { name: 'Module upgrade status' }).count(), 0, 'history is not on Installed');
                await page.screenshot({ path: path.join(root, `quiet-installed-${theme}-${width}.png`), fullPage: true });
                await installed.locator('summary').first().focus(); await page.keyboard.press('Enter');
                await installed.getByText('Up to date', { exact: true }).waitFor();
                await installed.locator('summary').first().focus(); await page.keyboard.press('Space');
                assert.equal(await installed.locator(':scope > details').evaluate((element: HTMLDetailsElement) => element.open), false);
                await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Audit', exact: true }).click();
                await page.getByRole('heading', { name: 'Migration job history', exact: true }).waitFor();
                await page.getByText('No recorded module upgrade jobs. This is history only, not a world-data readiness check.', { exact: true }).waitFor();
                await page.screenshot({ path: path.join(root, `quiet-audit-${theme}-${width}.png`), fullPage: true });
                for (const [label, route] of [['Overview', 'overview'], ['Cache', 'cache']]) {
                    await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: label, exact: true }).click();
                    await page.getByRole('heading', { name: label, exact: true }).waitFor();
                    assert.equal(await page.getByRole('region', { name: 'Migration attention', exact: true }).count(), 0, `healthy ${label} has no notice`);
                    assert.equal(await page.getByRole('region', { name: 'Current world migration status' }).count(), 0, `healthy ${label} has no detailed panel`);
                    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
                    await page.screenshot({ path: path.join(root, `quiet-${route}-${theme}-${width}.png`), fullPage: true });
                }
                await context.close(); continue;
            }
            await page.goto(`${origin}/admin`);
            const notice = page.getByRole('region', { name: 'Migration attention', exact: true });
            await notice.getByText('Migration required', { exact: true }).waitFor();
            assert.match(await notice.textContent() || '', /Core maintenance fixture · managed v1.0.0 · World: Controlled world \(w1\)/);
            styles[theme] = await notice.evaluate((element: Element) => getComputedStyle(element).backgroundColor);
            if (width < 640) assert.ok((await notice.locator('p').boundingBox()).width > width - 120, 'mobile notice text cannot be squeezed beside its action');
            assert.equal(await page.getByRole('region', { name: 'Current world migration status' }).count(), 0, 'Overview has only compact attention');
            assert.equal(await notice.getByText(/proposed writes|Last verified/).count(), 0);
            await page.screenshot({ path: path.join(root, `overview-${theme}-${width}.png`), fullPage: true });
            const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(element => element.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map(element => `${element.tagName}.${element.className}: ${element.getBoundingClientRect().right}`));
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overview ${width}/${theme}: ${overflow.join('\n')}`);
            await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Cache', exact: true }).click();
            await page.getByRole('heading', { name: 'Cache', exact: true }).waitFor();
            await notice.getByText('Migration required', { exact: true }).waitFor();
            assert.equal(await page.getByRole('region', { name: 'Current world migration status' }).count(), 0, 'unrelated pages have only compact attention');
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            await page.screenshot({ path: path.join(root, `cache-${theme}-${width}.png`), fullPage: true });
            const review = notice.getByRole('link', { name: 'Review migration', exact: true });
            const href = await review.getAttribute('href'); assert.match(href!, /source=managed/); assert.match(href!, /migration=/);
            await review.focus(); await page.keyboard.press('Enter');
            const drawer = page.getByRole('dialog', { name: 'Core maintenance fixture', exact: true }); await drawer.waitFor();
            const sourceReview = drawer.getByRole('region', { name: 'Source migration review' });
            await sourceReview.getByText('World data review · managed', { exact: true }).waitFor();
            await page.screenshot({ path: path.join(root, `review-identity-${theme}-${width}.png`), fullPage: false });
            await sourceReview.getByRole('button', { name: 'Review migration plan' }).click();
            await sourceReview.getByRole('button', { name: 'Enter maintenance', exact: true }).waitFor();
            await sourceReview.getByText('Proposed source paths', { exact: true }).click();
            assert.ok((await sourceReview.textContent())?.includes('Actor.a0'));
            for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
            assert.ok(await drawer.evaluate((element: Element) => element.contains(document.activeElement)), 'drawer confines keyboard focus');
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `review ${width}/${theme}`);
            await page.screenshot({ path: path.join(root, `review-${theme}-${width}.png`), fullPage: true });
            // CR64-22-R1: start with a loaded preview in an already-mounted
            // drawer. Full-page visits from an empty selection miss the defect.
            const navigationCases: string[] = [];
            const navigate = async (target: string) => {
                await page.evaluate((target: string) => history.pushState(null, '', target), target);
                await page.waitForFunction((target: string) => location.pathname + location.search === target, target);
            };
            for (const [label, target] of [
                ['missing-module', '/admin/modules?module=removed-fixture&source=managed&migration=retired-target'],
                ['unavailable-source', '/admin/modules?module=managed-only&source=local&migration=retired-target'],
                ['malformed-source', '/admin/modules?module=fixture&source=invalid&migration=retired-target'],
                ['missing-source', '/admin/modules?module=fixture&migration=retired-target'],
                ['duplicate-source', '/admin/modules?module=fixture&source=managed&source=local&migration=retired-target'],
                ['empty-scope', '/admin/modules?module=fixture&source=managed&migration='],
            ]) {
                await navigate(target);
                const explanation = page.getByRole('alert').filter({ hasText: /requested module\/source|review link is invalid/ });
                await explanation.waitFor({ state: 'visible' });
                const retired = { label, url: page.url(), drawers: await page.getByRole('dialog').count(),
                    reviews: await page.getByRole('region', { name: 'Source migration review' }).count(),
                    staleActions: await page.getByRole('button', { name: 'Enter maintenance', exact: true }).count() };
                fs.writeFileSync(path.join(root, `navigation-${label}-${theme}-${width}.json`), JSON.stringify(retired, null, 2));
                await page.screenshot({ path: path.join(root, `navigation-${label}-${theme}-${width}.png`), fullPage: true });
                assert.equal(retired.drawers, 0, `${label} must retire the prior source drawer`);
                assert.equal(retired.reviews, 0, `${label} must retire the loaded preview and its controls`);
                assert.equal(retired.staleActions, 0);
                await page.goBack(); await drawer.waitFor();
                await sourceReview.getByText('World data review · managed', { exact: true }).waitFor();
                assert.equal(await sourceReview.getByRole('button', { name: 'Enter maintenance', exact: true }).count(), 0, 'history must not resurrect a loaded preview');
                await page.goForward(); await explanation.waitFor({ state: 'visible' });
                assert.equal(await page.getByRole('dialog').count(), 0, 'forward history retires the drawer again');
                await page.goBack(); await drawer.waitFor();
                await sourceReview.getByRole('button', { name: 'Review migration plan' }).click();
                await sourceReview.getByRole('button', { name: 'Enter maintenance', exact: true }).waitFor();
                navigationCases.push(label);
            }
            const statusResponse = await page.request.get(`${origin}/api/admin/module-migrations`);
            assert.equal(statusResponse.status(), 200);
            const localHref = (await statusResponse.json()).sources.find((row: { moduleId: string; source: string; action: { href?: string } }) => row.moduleId === 'fixture' && row.source === 'local')?.action.href;
            assert.ok(localHref?.includes('source=local'));
            await navigate(localHref!);
            await sourceReview.getByText('World data review · local', { exact: true }).waitFor();
            assert.equal(await sourceReview.getByRole('button', { name: 'Enter maintenance', exact: true }).count(), 0, 'valid source change retires the previous preview');
            await sourceReview.getByRole('button', { name: 'Review migration plan' }).click();
            await sourceReview.getByText('This is an inactive local source. Inspecting it has not changed the selected source.', { exact: true }).waitFor();
            const stale = new URL(href!, origin); stale.searchParams.set('migration', 'retired-scope');
            await navigate(stale.pathname + stale.search);
            await sourceReview.getByText(/This review link names an older source\/world revision/).waitFor();
            assert.ok(await sourceReview.getByRole('button', { name: 'Check world data', exact: true }).isDisabled(), 'scope validation survives mounted navigation');
            await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'detached' });
            // Manual Details may override a URL intentionally, but never lose an
            // intended scope check when it names that exact card. Stable refresh
            // must preserve manual close/selection and disclosure choices.
            await page.getByRole('button', { name: 'Details', exact: true }).nth(1).click();
            await sourceReview.getByText(/This review link names an older source\/world revision/).waitFor();
            await page.keyboard.press('Escape');
            await page.getByRole('button', { name: 'Refresh', exact: true }).click();
            await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
            assert.equal(await page.getByRole('dialog').count(), 0, 'refresh must not reopen an explicitly closed URL-selected drawer');
            await navigate('/admin/modules');
            const localDisclosure = page.locator('details[data-migration-state="up-to-date"]');
            await localDisclosure.locator('summary').click();
            await page.getByRole('button', { name: 'Details', exact: true }).first().click();
            await sourceReview.getByText('World data review · local', { exact: true }).waitFor();
            await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'detached' });
            await page.getByRole('button', { name: 'Refresh', exact: true }).click();
            await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
            assert.equal(await page.getByRole('dialog').count(), 0, 'stable refresh preserves manual close');
            assert.ok(await localDisclosure.evaluate((element: HTMLDetailsElement) => element.open), 'stable refresh preserves disclosure');
            await localDisclosure.locator('summary').click();
            await page.getByRole('button', { name: 'Details', exact: true }).nth(1).click();
            await sourceReview.getByText('World data review · managed', { exact: true }).waitFor();
            assert.ok(await sourceReview.getByRole('button', { name: 'Check world data', exact: true }).isEnabled(), 'ordinary manual Details remains usable');
            fs.writeFileSync(path.join(root, `navigation-pass-${theme}-${width}.json`), JSON.stringify({ navigationCases, history: true, exactSource: true, manual: true, stableRefresh: true, staleScope: true }));
            await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'detached' });
            await page.getByRole('heading', { name: 'Modules - Installed', exact: true }).waitFor();
            assert.equal(await page.getByRole('region', { name: 'Migration attention', exact: true }).count(), 0, 'no duplicate Installed notice');
            await page.getByRole('region', { name: 'Current world migration status' }).getByText('25 proposed writes · 32 checked', { exact: true }).waitFor();
            assert.equal(await page.getByRole('region', { name: 'Module upgrade status' }).count(), 0);
            assert.equal(await page.getByText('No recorded module upgrade jobs. This is history only, not a world-data readiness check.', { exact: true }).count(), 0);
            const titleBounds = await page.getByRole('heading', { name: 'Core maintenance fixture', level: 3 }).first().boundingBox();
            assert.ok(titleBounds.width > 150, 'mobile card content cannot be crushed alongside action buttons');
            const inactive = page.locator('details[data-migration-state="up-to-date"]');
            assert.equal(await inactive.evaluate((element: HTMLDetailsElement) => element.open), false);
            assert.match(await inactive.locator('summary').textContent(), /local v1.0.1/);
            await page.screenshot({ path: path.join(root, `installed-${theme}-${width}.png`), fullPage: true });
            await inactive.locator('summary').click();
            assert.ok(await page.getByText('Inactive local source — inspection does not switch sources', { exact: true }).isVisible());
            assert.ok(await page.getByText('0 proposed writes', { exact: false }).count() > 0);
            await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Audit', exact: true }).click();
            await page.getByRole('heading', { name: 'Migration job history', exact: true }).waitFor();
            await page.getByText('No recorded module upgrade jobs. This is history only, not a world-data readiness check.', { exact: true }).waitFor();
            await page.screenshot({ path: path.join(root, `audit-${theme}-${width}.png`), fullPage: true });
            if (width === 1440 && theme === 'dark') {
                const old = new URL(href!, origin); old.searchParams.set('migration', 'retired-scope');
                await page.goto(old.href); await page.getByText(/This review link names an older source\/world revision/).waitFor();
                assert.equal(await page.getByRole('region', { name: 'Source migration review' }).getByRole('button', { name: 'Check world data' }).isDisabled(), true);
                await page.getByRole('link', { name: 'Open the current source review' }).click();
                await page.getByRole('region', { name: 'Source migration review' }).getByRole('button', { name: 'Review migration plan' }).waitFor();
            }
            await context.close();
        }
        if (!quiet) { assert.notEqual(styles.light, styles.dark); assert.ok(Object.values(styles).every(style => style !== 'rgba(0, 0, 0, 0)')); }
        assert.deepEqual(errors, []); assert.deepEqual(requests, [], 'notice navigation and cached review cannot scan, enter maintenance or approve');
        return { rendered: quiet ? 32 : 40, quiet, widths: [320, 390, 820, 1440], themes: styles, keyboard: true, exactSource: true, readOnlyNavigation: true, staleLink: !quiet };
    } finally { await browser.close(); }
}

export async function inspectCompletedMigrationHistory(origin: string, cookie: string, root: string, writes: number) {
    const { chromium } = await import(process.env.SD_PLAYWRIGHT_MODULE!);
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
    try {
        for (const width of [320, 390, 820, 1440]) for (const theme of ['light', 'dark'] as const) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
            const [name, ...value] = cookie.split('='); await context.addCookies([{ name, value: value.join('='), url: origin, httpOnly: true }]);
            await context.addInitScript((theme: string) => localStorage.setItem('admin-theme', theme), theme);
            const page = await context.newPage(); await page.goto(`${origin}/admin/audit#module-upgrade-history`);
            const history = page.getByRole('region', { name: 'Module upgrade status' });
            await history.getByText(`fixture 1.0.0: completed`, { exact: true }).waitFor();
            await history.getByText(`${writes} confirmed target writes.`, { exact: true }).waitFor();
            assert.equal(await page.getByRole('region', { name: 'Current world migration status' }).count(), 0);
            assert.equal(await page.getByRole('region', { name: 'Migration attention' }).count(), 0, 'completed history alone does not create current attention');
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            await page.screenshot({ path: path.join(root, `audit-completed-${theme}-${width}.png`), fullPage: true });
            await context.close();
        }
    } finally { await browser.close(); }
}
