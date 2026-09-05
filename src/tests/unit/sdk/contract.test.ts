import { strict as assert } from 'node:assert';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// A fixture module uses ONLY the public SDK surface (the three entry points), exercised
// against @sheet-delver/sdk/testing — the contract test required by ADR-0027 decision 30.
import { capabilities } from '../../../shared/sdk';
import { useSDK, useActorSheet, createActorPage, type ActorSheetProps } from '../../../shared/sdk/entry-react';
import {
    createMockModuleRuntime,
    createMockSdkContext,
    createMockSdkEvents,
    MockSDKProvider,
} from '../../../shared/sdk/testing';

// --- Fixture presentational sheet (public ActorSheetProps + useSDK().assetUrl) ---
function FixtureSheet({ actor }: ActorSheetProps) {
    const { assetUrl } = useSDK();
    const name = String((actor as { name?: string }).name ?? 'Unknown');
    return createElement(
        'div',
        { className: 'fixture-sheet' },
        createElement('img', { src: assetUrl('icon.png'), alt: '' }),
        createElement('h1', null, name),
    );
}

async function runServerRuntimeContract() {
    const runtime = createMockModuleRuntime({
        compendium: { Item: [{ _id: 'torch', name: 'Torch', type: 'Gear', uuid: 'Compendium.mock.items.Item.torch' }] },
    });

    // fetch + mutate through the runtime document store
    const created = await runtime.documents.create('Actor', { name: 'Goblin' });
    const fetched = await runtime.documents.get('Actor', created._id as string);
    assert.equal((fetched as { name?: string })?.name, 'Goblin');
    await runtime.documents.patch('Actor', created._id as string, { name: 'Hobgoblin' });
    assert.equal((await runtime.documents.get('Actor', created._id as string) as { name?: string })?.name, 'Hobgoblin');

    // send a roll
    const roll = await runtime.rolls.roll('2d6+3');
    assert.equal(roll.total, 11);

    // resolve a declared compendium document
    const torch = await runtime.compendium.findOne('Item', { name: 'Torch' });
    assert.equal((torch as { _id?: string })?._id, 'torch');
    const byUuid = await runtime.compendium.getById('Item', 'Compendium.mock.items.Item.torch');
    assert.equal((byUuid as { _id?: string })?._id, 'torch');

    // persist via DataStore
    await runtime.dataStore.set('lastSeen', 1234);
    assert.equal(await runtime.dataStore.get<number>('lastSeen'), 1234);
    assert.equal(await runtime.dataStore.has('lastSeen'), true);
    assert.deepEqual(await runtime.dataStore.keys(), ['lastSeen']);
}

function runRenderSheetContract() {
    // render a sheet through the platform host (createActorPage → useActorSheet → Sheet)
    const context = createMockSdkContext({
        documents: { Actor: { a1: { _id: 'a1', id: 'a1', name: 'Hero Mock', isOwner: true } } },
    });
    const Page = createActorPage(FixtureSheet);
    const html = renderToStaticMarkup(
        createElement(MockSDKProvider, { context }, createElement(Page, { actorId: 'a1' })),
    );

    assert.ok(html.includes('Hero Mock'), 'sheet renders the actor name');
    // resolve a packaged asset URL
    assert.ok(html.includes('/api/modules/mock/assets/icon.png'), 'assetUrl resolves to the module asset route');
}

function runRealtimeContract() {
    // process a realtime change
    const events = createMockSdkEvents();
    const seen: Array<{ type: string; id: string }> = [];
    const off = events.on('document:changed', (p) => seen.push({ type: p.type, id: p.id }));
    events.emit('document:changed', { type: 'Actor', id: 'a1', action: 'update' });
    off();
    events.emit('document:changed', { type: 'Actor', id: 'a2', action: 'update' });
    assert.deepEqual(seen, [{ type: 'Actor', id: 'a1' }]);
}

function runNavigationContract() {
    const seen: string[] = [];
    const context = createMockSdkContext({
        overrides: {
            navigate: (target) => seen.push(`push:${target}`),
            replace: (target) => seen.push(`replace:${target}`),
        },
    });
    context.navigate('/tools/mock/generator');
    context.replace('/actors/a1');
    assert.deepEqual(seen, ['push:/tools/mock/generator', 'replace:/actors/a1']);
}

function runCapabilityContract() {
    for (const cap of ['documents', 'rolls', 'compendium', 'settings', 'assets', 'navigation', 'events'] as const) {
        assert.equal(capabilities.supports(cap), true, `capability ${cap} supported`);
    }
}

export async function run() {
    await runServerRuntimeContract();
    runRenderSheetContract();
    runRealtimeContract();
    runNavigationContract();
    runCapabilityContract();
    console.log('  - SDK contract (mock host + fixture module): all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('contract.test.ts passed'))
        .catch((error) => { console.error(error); process.exit(1); });
}
