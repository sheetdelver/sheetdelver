import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { NextRequest } from 'next/server';
import { proxy } from '../../../proxy';
import { maintenanceShell } from '@server/app/maintenanceShell';

export function run(): void {
    const bundle = buildSync({ entryPoints: [path.resolve('src/proxy.ts')], bundle: true,
        platform: 'node', packages: 'external', write: false, metafile: true });
    assert.ok(!Object.keys(bundle.metafile!.inputs).some(file => /server\/core\/(paths\.ts|world\/MaintenanceMode\.ts)$/.test(file)),
        'Next proxy must not trace Core startup paths, maintenance writers or leases');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-maintenance-navigation-'));
    const priorData = process.env.SHEET_DELVER_DATA, priorOrigin = process.env.APP_ADMIN_ORIGIN;
    process.env.SHEET_DELVER_DATA = directory; process.env.APP_ADMIN_ORIGIN = 'http://localhost:3000';
    const request = (route: string, host = 'localhost:3000') => new NextRequest(`http://${host}${route}`, { headers: { host } });
    try {
        assert.equal(proxy(request('/actors/a')).headers.get('x-middleware-next'), '1');
        const config = path.join(directory, 'config/module-upgrades'); fs.mkdirSync(config, { recursive: true });
        fs.writeFileSync(path.join(config, 'maintenance.json'), JSON.stringify({ schemaVersion: 1, id: 'review', moduleId: 'fixture', stage: 'review', drained: true, updatedAt: 0 }));
        for (const route of ['/', '/actors/a', '/tools/generator']) {
            const response = proxy(request(route)); assert.equal(response.status, 503);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.match(response.headers.get('content-type') ?? '', /text\/html/);
            assert.equal(response.headers.get('x-middleware-next'), null, 'player routes never render');
        }
        for (const route of ['/admin', '/admin/modules', '/api/admin/auth/login']) {
            assert.equal(proxy(request(route)).headers.get('x-middleware-next'), '1', 'regular admin routes and cookie scope are unchanged');
            assert.equal(proxy(request(route, 'public.invalid')).status, 404, 'admin host concealment remains enforced');
        }
        for (const stage of ['entering', 'isolated', 'planning', 'review', 'executing', 'recovery-required', 'activating', 'serving']) {
            for (const drained of [false, true]) {
                fs.writeFileSync(path.join(config, 'maintenance.json'), JSON.stringify({ schemaVersion: 1, id: 'stage-check', moduleId: 'fixture', stage, drained, updatedAt: 0 }));
                const serving = ['activating', 'serving'].includes(stage) && drained;
                assert.equal(proxy(request('/')).status, serving ? 200 : 503, `${stage}, drained=${drained}`);
            }
        }
        assert.match(maintenanceShell, /<h1>SheetDelver is in maintenance<\/h1>/);
        assert.doesNotMatch(maintenanceShell, /<form|<input|<button|\/admin|Administrator|proposed|Foundry/);
        fs.writeFileSync(path.join(config, 'maintenance.json'), '{broken');
        assert.equal(proxy(request('/')).status, 503, 'unreadable maintenance state remains closed');
        assert.equal(proxy(request('/admin')).headers.get('x-middleware-next'), '1', 'admin recovery remains reachable');
        fs.writeFileSync(path.join(config, 'maintenance.json'), JSON.stringify({ schemaVersion: 2, id: 'invalid', moduleId: 'fixture', stage: 'serving', drained: true }));
        assert.equal(proxy(request('/')).status, 503, 'invalid record schema remains closed');
        fs.writeFileSync(path.join(config, 'maintenance.json'), ' '.repeat(65_537));
        assert.equal(proxy(request('/')).status, 503, 'oversized record remains closed');
        console.log('  - maintenance navigation preserves normal admin and gates clients: passed');
    } finally {
        if (priorData === undefined) delete process.env.SHEET_DELVER_DATA; else process.env.SHEET_DELVER_DATA = priorData;
        if (priorOrigin === undefined) delete process.env.APP_ADMIN_ORIGIN; else process.env.APP_ADMIN_ORIGIN = priorOrigin;
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
