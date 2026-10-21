import assert from 'node:assert/strict';
import { FoundryPackageService } from '@server/services/world/FoundryPackageService';
import type { GameData } from '@server/core/world/types';
import type { ModuleWorldContext } from '@shared/sdk/world';

const uuid = 'Compendium.fixture.monsters.Actor.monster';
const mapping = (pkg = 'art', image = 'portrait.webp') => ({ 'fixture.monsters': { monster: {
    actor: `modules/${pkg}/${image}`, token: { texture: { src: `modules/${pkg}/token.webp` } },
} } });
const source = (active: boolean | undefined = true): GameData => ({ world: { id: 'w' }, system: { id: 'fixture', version: '1.0' }, modules: [
    { id: 'art', title: 'Optional art', version: '1.3', active, flags: { compendiumArtMappings: { fixture: { mapping: 'modules/art/mapping.json', credit: 'Artist' } } }, download: 'secret-do-not-expose' },
] });
function setup() {
    let preferences: unknown; let ready = true; let worldRevision = 1; let readable = true; let count = 0; let now = 0;
    let reply: (input: string, signal?: AbortSignal | null) => Promise<Response> = async () => Response.json(mapping());
    const metadata = [{ id: 'fixture.monsters', type: 'Actor', packageType: 'system', packageName: 'fixture', label: 'Monsters' },
        { id: 'art.items', type: 'Item', packageType: 'module', packageName: 'art', label: 'Hidden items' }];
    const service = new FoundryPackageService({ getValueByKey: () => preferences, isReady: () => ready }, {
        listPackMetadata: () => structuredClone(metadata), getPackMetadata: id => metadata.find(row => row.id === id) ?? null,
    }, async (input, init) => {
        count++; assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error'); assert.equal(init?.headers, undefined);
        return reply(String(input), init?.signal);
    }, () => now);
    const world = { snapshot: () => ({ identity: { contextRevision: worldRevision, foundryGeneration: 14 } }),
        assertRevision: revision => { if (revision !== worldRevision) throw Error('retired world'); } } as ModuleWorldContext;
    service.configure('https://foundry.example/game/', source(), 1);
    return { service, world, handle: () => service.handle(world, pack => readable && pack === 'fixture.monsters'),
        count: () => count, setReply: (fn: typeof reply) => { reply = fn; }, setPreferences: (value: unknown) => { preferences = value; service.refreshPreferences(); },
        retire: () => worldRevision++, revoke: () => { readable = false; }, unready: () => { ready = false; }, advance: (ms: number) => { now += ms; } };
}

export async function run() {
    let checks = 0;
    const test = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); checks++; console.log(`  ✓ ${name}`); };
    await test('package discovery is immutable, redacted, caller-filtered and zero-I/O', () => {
        const t = setup(); const snapshot = t.handle().snapshot(); assert.equal(snapshot.status, 'ready');
        if (snapshot.status !== 'ready') throw Error('metadata missing');
        assert.equal(snapshot.system.packs.length, 1); assert.equal(snapshot.modules[0].packs.length, 0);
        assert.equal(snapshot.modules[0].enabled, true); assert.equal(snapshot.modules[0].version, '1.3');
        assert.equal(snapshot.modules[0].capabilities.compendiumArt, true);
        assert.ok(Object.isFrozen(snapshot.modules[0])); assert.doesNotMatch(JSON.stringify(snapshot), /secret-do-not-expose|mapping.json|flags/);
        assert.equal(t.count(), 0);
    });
    await test('native image/token mapping uses exact pack, ID and declared provider', async () => {
        const t = setup(); const handle = t.handle();
        assert.deepEqual(await handle.resolve(uuid), { status: 'resolved', src: 'https://foundry.example/game/modules/art/portrait.webp', packageId: 'art', credit: 'Artist' });
        assert.equal((await handle.resolve(uuid, 'token') as { src: string }).src, 'https://foundry.example/game/modules/art/token.webp');
        assert.deepEqual(await handle.resolve(uuid.replace('monster', 'other')), { status: 'unavailable', reason: 'not-visible' });
        assert.deepEqual(await handle.resolve('Compendium.fixture.monsters.Actor.unknown'), { status: 'none' });
        assert.equal(t.count(), 1);
    });
    await test('absent, disabled and unknown-enabled packages never load artwork', async () => {
        for (const active of [false, undefined]) {
            const t = setup(); const data = source(active); if (active === undefined) delete data.modules![0].active; t.service.configure('https://foundry.example/game/', data, 1);
            assert.deepEqual(await t.handle().resolve(uuid), { status: 'none' }); assert.equal(t.count(), 0);
        }
        const t = setup(); t.service.configure('https://foundry.example/', { ...source(), modules: [] }, 1);
        assert.deepEqual(await t.handle().resolve(uuid), { status: 'none' }); assert.equal(t.count(), 0);
        t.service.configure('https://foundry.example/', { ...source(), modules: undefined }, 1);
        assert.deepEqual(t.handle().snapshot(), { status: 'unavailable', reason: 'incomplete-metadata' });
    });
    await test('Foundry portrait and token preferences remain independent', async () => {
        const t = setup(); const revisions: number[] = []; t.service.on('changed', change => revisions.push(change.revision));
        t.setPreferences({ art: { portraits: false } }); assert.deepEqual(await t.handle().resolve(uuid), { status: 'none' }); assert.equal(t.count(), 0);
        assert.equal((await t.handle().resolve(uuid, 'token')).status, 'resolved');
        t.setPreferences({ art: { tokens: false } }); assert.equal((await t.handle().resolve(uuid)).status, 'resolved');
        assert.deepEqual(await t.handle().resolve(uuid, 'token'), { status: 'none' });
        assert.equal(revisions.length, 2); assert.deepEqual(t.world.snapshot().identity, { contextRevision: 1, foundryGeneration: 14 }, 'art does not change rule context or acquire a migration gate');
    });
    await test('Item image uses native img field and independent items preference', async () => {
        const t = setup(); const handle = t.service.handle(t.world, () => true);
        const item = 'Compendium.art.items.Item.item';
        t.setReply(async () => Response.json({ 'art.items': { item: { actor: 'modules/art/actor.webp' } } }));
        assert.deepEqual(await handle.resolve(item), { status: 'none' }, 'Actor alias is not an Item image');
        t.advance(300001);
        t.setReply(async () => Response.json({ 'art.items': { item: { img: 'modules/art/item.webp' } } }));
        assert.equal((await handle.resolve(item) as {src: string}).src, 'https://foundry.example/game/modules/art/item.webp');
        t.setPreferences({ art: { items: false } });
        assert.deepEqual(await handle.resolve(item), { status: 'none' });
        assert.equal((await handle.resolve(item, 'token')).status, 'unavailable');
    });
    await test('v13 preserves partial preference semantics and Actor-only mappings', async () => {
        const t = setup();
        const legacy = { ...t.world, snapshot: () => ({ identity: { contextRevision: 1, foundryGeneration: 13 } }) } as unknown as ModuleWorldContext;
        const handle = t.service.handle(legacy, () => true);
        t.setPreferences({ art: { portraits: true } });
        assert.equal((await handle.resolve(uuid)).status, 'resolved');
        assert.deepEqual(await handle.resolve(uuid, 'token'), { status: 'none' });
        assert.deepEqual(await handle.resolve('Compendium.art.items.Item.item'), { status: 'none' });
        const future = { ...legacy, snapshot: () => ({ identity: { contextRevision: 1, foundryGeneration: 15 } }) } as unknown as ModuleWorldContext;
        assert.deepEqual(await t.service.handle(future).resolve(uuid), { status: 'unavailable', reason: 'unsupported-version' });
    });
    await test('native explicit priority, stable defaults and disabled higher provider', async () => {
        const t = setup(); const data = source();
        data.modules!.push({ id: 'second', active: true, flags: { compendiumArtMappings: { fixture: { mapping: 'modules/second/art.json' } } } });
        t.service.configure('https://foundry.example/game/', data, 1);
        t.setReply(async url => Response.json(mapping(url.includes('/second/') ? 'second' : 'art')));
        assert.equal((await t.handle().resolve(uuid) as { packageId: string }).packageId, 'art');
        t.setPreferences({ second: { priority: -10 } });
        assert.equal((await t.handle().resolve(uuid) as { packageId: string }).packageId, 'second');
        t.setPreferences({ second: { priority: -10, portraits: false } });
        assert.equal((await t.handle().resolve(uuid) as { packageId: string }).packageId, 'art');
    });
    await test('invalid config, references, absent packs and mismatched types fail without fetching', async () => {
        for (const preferences of [null, [], { art: null }, { art: { portraits: 'true' } }, { art: { priority: 'first' } }]) {
            const t = setup(); t.setPreferences(preferences); assert.equal((await t.handle().resolve(uuid)).status, 'unavailable'); assert.equal(t.count(), 0);
        }
        const t = setup();
        for (const invalid of ['Actor.monster', 'Compendium.fixture.monsters.monster', '', uuid.replace('.Actor.', '.Item.')]) assert.equal((await t.handle().resolve(invalid)).status, 'unavailable');
        t.revoke(); assert.deepEqual(await t.handle().resolve(uuid), { status: 'unavailable', reason: 'not-visible' }); assert.equal(t.count(), 0);
    });
    await test('asset failure, malformed JSON, oversized streams and unsafe paths remain optional', async () => {
        for (const response of [() => new Response('', { status: 404 }), () => new Response('<html>login</html>'),
            () => new Response(' '.repeat(2_097_153)), () => new Response('{}', { headers: { 'content-length': '2097153' } }),
            () => { throw Error('offline'); }]) {
            const t = setup(); t.setReply(async () => response()); assert.deepEqual(await t.handle().resolve(uuid), { status: 'unavailable', reason: 'asset-unavailable' });
        }
        for (const path of ['https://elsewhere.example/img.webp', 'modules/art/../../secret', 'modules/art/%2e%2e%2fsecret', 'modules/art/a.webp?credential=x', 'data:image/png;base64,AAAA']) {
            const t = setup(); t.setReply(async () => Response.json({ 'fixture.monsters': { monster: { actor: path } } }));
            assert.equal((await t.handle().resolve(uuid)).status, 'unavailable');
        }
    });
    await test('mapping paths cannot escape their provider or follow redirects', async () => {
        for (const path of ['https://external.example/map.json', 'modules/other/map.json', 'modules/art/../other/map.json']) {
            const t = setup(); const data = source(); (data.modules![0].flags!.compendiumArtMappings as any).fixture.mapping = path;
            t.service.configure('https://foundry.example/game/', data, 1);
            assert.equal((await t.handle().resolve(uuid)).status, 'unavailable'); assert.equal(t.count(), 0);
        }
    });
    await test('concurrent reads share assets; failures retry; positive assets expire', async () => {
        const t = setup(); await Promise.all(Array.from({ length: 20 }, () => t.handle().resolve(uuid))); assert.equal(t.count(), 1);
        t.advance(300_001); await t.handle().resolve(uuid); assert.equal(t.count(), 2);
        const missing = setup(); missing.setReply(async () => new Response('', { status: 404 }));
        await missing.handle().resolve(uuid); await missing.handle().resolve(uuid); assert.equal(missing.count(), 1);
        missing.advance(10_001); missing.setReply(async () => Response.json(mapping())); assert.equal((await missing.handle().resolve(uuid)).status, 'resolved');
    });
    await test('permission, rules, art settings and teardown races retire pending results', async () => {
        for (const retire of [(t: ReturnType<typeof setup>) => t.revoke(), (t: ReturnType<typeof setup>) => t.retire(),
            (t: ReturnType<typeof setup>) => t.setPreferences({ art: { portraits: false } }), (t: ReturnType<typeof setup>) => t.service.clear()]) {
            const t = setup(); t.setReply(async () => { retire(t); return Response.json(mapping()); });
            assert.equal((await t.handle().resolve(uuid)).status, 'unavailable');
        }
    });
    await test('same-world recovery refreshes existing handles; new world retires them', async () => {
        const t = setup(); const handle = t.handle(); await handle.resolve(uuid);
        t.service.suspend();
        assert.equal(handle.snapshot().status, 'unavailable');
        t.service.configure('https://foundry.example/game/', source(false), 1);
        assert.deepEqual(await handle.resolve(uuid), { status: 'none' });
        t.service.configure('https://foundry.example/game/', { ...source(), world: { id: 'other' } }, 2);
        assert.throws(() => handle.snapshot(), /retired/); assert.equal((await handle.resolve(uuid)).status, 'unavailable');
    });
    console.log(`foundry-packages: ${checks} groups passed`);
}
if (import.meta.url === `file://${process.argv[1]}`) run().catch(error => { console.error(error); process.exitCode = 1; });
