import assert from 'node:assert/strict';
import { prepareCompendiumReference, referenceIdentity } from '@server/services/artwork/CompendiumReferenceService';
import type { CompendiumReferenceRuntime, SystemAdapter } from '@shared/sdk';

export async function run() {
    let groups = 0;
    const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); groups++; console.log(`  ✓ ${name}`); };
    const reference = referenceIdentity('Compendium.fixture.monsters.Actor.monster')!;
    const original = { _id: 'monster', name: 'Original', system: { hp: 20 } };
    let source: typeof original | null = structuredClone(original);
    const runtime = { documents: { fetchByUuid: async (uuid: string) => { assert.equal(uuid, reference.uuid); return source; } } } as Omit<CompendiumReferenceRuntime, 'signal'>;
    const options = { isCurrent: () => true };
    const adapter: Pick<SystemAdapter, 'prepareReferenceView'> = { prepareReferenceView: async context => ({ title: String(context.document.name), model: context.document }) };
    await check('only exact typed Actor/Item compendium roots are supported', () => {
        for (const uuid of ['Actor.a', 'Compendium.p.q', 'Compendium.p.q.Actor.a.Item.b', 'Compendium.p.q.JournalEntry.a', '', null]) assert.equal(referenceIdentity(uuid), null);
        assert.equal(referenceIdentity('Compendium.p.q.Item.i')?.documentType, 'Item');
        assert.equal(reference.documentType, 'Actor');
    });
    await check('opt-out and module-declined sources return no view', async () => {
        assert.equal(await prepareCompendiumReference({}, reference, runtime, options), null);
        assert.equal(await prepareCompendiumReference({ prepareReferenceView: async () => null }, reference, runtime, options), null);
    });
    await check('original source is frozen and runtime has no writes or rolls', async () => {
        const result = await prepareCompendiumReference({ prepareReferenceView: async (context, caller) => {
            assert.ok(Object.isFrozen(context.document.system));
            assert.equal('rolls' in caller, false); assert.equal('create' in caller.documents, false);
            return { title: 'Original', model: context.document };
        } }, reference, runtime, options);
        assert.deepEqual(result, { title: 'Original', model: original }); assert.deepEqual(source, original);
    });
    await check('missing source and denied caller reads expose nothing', async () => {
        source = null; assert.equal(await prepareCompendiumReference(adapter, reference, runtime, options), null); source = structuredClone(original);
        const denied = { ...runtime, documents: { ...runtime.documents, fetchByUuid: async () => { throw Error('denied'); } } };
        assert.equal(await prepareCompendiumReference(adapter, reference, denied, options), null);
    });
    await check('late source edits/deletions and revocation retire prepared results', async () => {
        for (const next of [null, { ...original, name: 'Changed' }]) {
            source = structuredClone(original);
            assert.equal(await prepareCompendiumReference({ prepareReferenceView: async () => { source = next; return { title: 'Old', model: original }; } }, reference, runtime, options), null);
        }
        source = structuredClone(original);
        let reads = 0;
        const revoked = { ...runtime, documents: { ...runtime.documents, fetchByUuid: async () => { if (++reads > 1) throw Error('revoked'); return original; } } };
        assert.equal(await prepareCompendiumReference(adapter, reference, revoked, options), null);
    });
    await check('changed world/caller/target fences pending module work', async () => {
        let current = true;
        assert.equal(await prepareCompendiumReference({ prepareReferenceView: async () => { current = false; return { title: 'Old', model: original }; } }, reference, runtime, { isCurrent: () => current }), null);
    });
    await check('deadline bounds reads and module work, disconnect aborts', async () => {
        const hung = { ...runtime, documents: { ...runtime.documents, fetchByUuid: async () => new Promise<null>(() => {}) } };
        assert.equal(await prepareCompendiumReference(adapter, reference, hung, { ...options, timeoutMs: 5 }), null);
        let signal: AbortSignal | undefined;
        assert.equal(await prepareCompendiumReference({ prepareReferenceView: async (_, caller) => { signal = caller.signal; return new Promise(() => {}); } }, reference, runtime, { ...options, timeoutMs: 5 }), null);
        assert.equal(signal?.aborted, true);
        const abort = new AbortController(); abort.abort();
        assert.equal(await prepareCompendiumReference(adapter, reference, runtime, { ...options, signal: abort.signal }), null);
    });
    await check('failed, oversized and unserializable models are optional failures', async () => {
        for (const model of [undefined, 'a'.repeat(512 * 1024), BigInt(1)]) assert.equal(await prepareCompendiumReference({ prepareReferenceView: async () => ({ title: 'Bad', model }) }, reference, runtime, options), null);
        assert.equal(await prepareCompendiumReference({ prepareReferenceView: async () => { throw Error('module failed'); } }, reference, runtime, options), null);
    });
    await check('Item contract reads its own exact source independently', async () => {
        const item = referenceIdentity('Compendium.fixture.items.Item.item')!;
        const itemRuntime = { ...runtime, documents: { ...runtime.documents, fetchByUuid: async (uuid: string) => { assert.equal(uuid, item.uuid); return { name: 'Reference Item', type: 'weapon' }; } } };
        assert.equal((await prepareCompendiumReference(adapter, item, itemRuntime, options))?.title, 'Reference Item');
    });
    console.log(`Compendium reference: ${groups} groups passed`);
}
