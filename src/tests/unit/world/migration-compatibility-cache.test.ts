import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDataDir, initDataDir, getCacheDir } from '@server/core/paths';
import { createCompatibilityCheck } from '@server/services/world/migrations/compatibilityCache';
import { computeWorldMigrations } from '@server/services/world/migrations/compute';
import { discoverMigrations } from '@modules/registry/migrations/catalog';
import type { UpgradeSourceSnapshot } from '@server/services/world/migrations/ModuleUpgradeCoordinator';
import { fixture, world } from './module-world-migrations.test';

export async function run() {
    const previous = getDataDir(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-compat-cache-'));
    initDataDir(root);
    try {
        const candidate = fixture(path.join(root, 'module'));
        const catalog = discoverMigrations(candidate.root, candidate.info)!;
        let executions = 0, current = true;
        const source: UpgradeSourceSnapshot & { assertCurrent(): void } = { world: structuredClone(world), targets: [{ kind: 'Actor', uuid: 'Actor.a', source: { _id: 'a', system: { fixed: true } } }], exclusions: [],
            assertCurrent: () => { if (!current) throw new Error('source retired'); } };
        const compute: typeof computeWorldMigrations = async (...args) => { executions++; return computeWorldMigrations(...args); };
        const create = () => createCompatibilityCheck(candidate.root, catalog, candidate.info, compute);
        const initial = create();
        assert.equal((await initial.check(source)).reused, false); assert.equal(executions, 1);
        assert.equal((await initial.check(source)).reused, true); assert.equal(executions, 1, 'unchanged post-preparation does not rerun hooks');
        await initial.remember(source);
        const restored = create();
        assert.equal((await restored.check(source)).reused, true); assert.equal(executions, 1, 'new checker reuses persisted exact successful inputs');
        source.targets[0].source.system = { fixed: false };
        assert.equal((await restored.check(source)).plan.blockers.length, 1); assert.equal(executions, 2, 'restored legacy data never uses current-data result');
        await restored.check(source); assert.equal(executions, 3, 'blocked results are never cached');
        source.targets[0].source.system = { fixed: true };
        for (const change of [
            () => { source.world = { ...source.world, settings: { 'fixture.mode': { status: 'world', value: true } } }; },
            () => { source.world = { ...source.world, identity: { ...source.world.identity, foundryBuild: '368' } }; },
            () => { source.world = { ...source.world, identity: { ...source.world.identity, contextRevision: 2 } }; },
            () => { source.targets.push({ kind: 'Actor', uuid: 'Actor.b', source: { _id: 'b', system: { fixed: true } } }); },
            () => { source.targets[0].readOnly = true; },
            () => { source.exclusions = ['Advisory pack unavailable']; },
        ]) {
            const before: number = executions; change();
            assert.equal((await restored.check(source)).reused, false); assert.equal(executions, before + 1);
        }
        await restored.remember(source);
        catalog.digest = 'changed-hooks';
        assert.equal((await create().check(source)).reused, false, 'catalog/hook changes retire the result');
        const cache = path.join(getCacheDir(), 'migration-checks');
        for (const file of fs.readdirSync(cache)) fs.writeFileSync(path.join(cache, file), '{broken');
        assert.equal((await create().check(source)).reused, false, 'corruption triggers fresh computation');
        current = false;
        await assert.rejects(restored.check(source), /retired/);
        await assert.rejects(restored.remember(source), /retired/);
        current = true;
        const changedSource = createCompatibilityCheck(candidate.root, catalog, { ...candidate.info, version: '2.0.0' }, compute);
        assert.equal((await changedSource.check(source)).reused, false, 'module identity changes retire the result');
        fs.rmSync(cache, { recursive: true }); fs.writeFileSync(cache, 'not a directory');
        await changedSource.remember(source);
        assert.equal((await create().check(source)).plan.blockers.length, 0, 'cache IO failure does not block current world data');
        console.log('migration compatibility cache: exact reuse, persistence, restored sources, context/catalog changes, corruption and stale fences passed');
    } finally { initDataDir(previous); fs.rmSync(root, { recursive: true, force: true }); }
}
if (import.meta.url === `file://${process.argv[1]}`) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-cache-unit-')); initDataDir(root);
    run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}
