import { strict as assert } from 'node:assert';
import { createClientDocumentSource } from '@client/ui/sdk/createClientDocumentSource';

/**
 * Exercises the host-owned client document cache (ADR-0027 decisions 17/25):
 * concurrent-read dedup, snapshot stability, subscribe notifications, invalidation
 * (realtime + write-through), and the typed mutation surface.
 */

interface FetchCall { url: string; init?: RequestInit }

function makeFetch(calls: FetchCall[], body: () => unknown, status = 200) {
    return async (url: string, init?: RequestInit): Promise<Response> => {
        calls.push({ url, init });
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => body(),
        } as Response;
    };
}

async function tick() {
    await Promise.resolve();
    await Promise.resolve();
}

export async function run() {
    await runReadDedupAndSnapshot();
    await runSubscribeAndInvalidate();
    await runMutationInvalidates();
    await runNotFound();
    console.log('  - Client document source (cache/dedup/invalidation): all checks passed');
}

async function runReadDedupAndSnapshot() {
    const calls: FetchCall[] = [];
    let version = 0;
    const source = createClientDocumentSource(makeFetch(calls, () => ({ id: 'a1', name: `Actor v${version}` })));

    // Initial snapshot is a stable, loading-ish empty reference.
    const first = source.getSnapshot('Actor', 'a1');
    assert.equal(source.getSnapshot('Actor', 'a1'), first, 'snapshot reference is stable until change');

    // Two concurrent reads of the same key share one in-flight fetch (dedup).
    const p1 = source.refresh('Actor', 'a1');
    const p2 = source.refresh('Actor', 'a1');
    await Promise.all([p1, p2]);
    assert.equal(calls.length, 1, 'concurrent reads of the same key dedup to one fetch');

    const snap = source.getSnapshot<{ name: string }>('Actor', 'a1');
    assert.equal(snap.loading, false);
    assert.equal(snap.notFound, false);
    assert.equal(snap.data?.name, 'Actor v0');
}

async function runSubscribeAndInvalidate() {
    const calls: FetchCall[] = [];
    let version = 0;
    const source = createClientDocumentSource(makeFetch(calls, () => ({ id: 'a1', name: `Actor v${version}` })));

    let notifications = 0;
    const unsubscribe = source.subscribe('Actor', 'a1', () => { notifications += 1; });

    await source.refresh('Actor', 'a1');
    assert.ok(notifications > 0, 'subscriber notified on refresh');
    assert.equal(source.getSnapshot<{ name: string }>('Actor', 'a1').data?.name, 'Actor v0');

    // Invalidate while observed → triggers a re-fetch from the single source.
    version = 1;
    const before = calls.length;
    source.invalidate('Actor', 'a1');
    await tick();
    assert.equal(calls.length, before + 1, 'invalidate of an observed key re-fetches');
    assert.equal(source.getSnapshot<{ name: string }>('Actor', 'a1').data?.name, 'Actor v1');

    unsubscribe();
}

async function runMutationInvalidates() {
    const calls: FetchCall[] = [];
    let version = 0;
    const source = createClientDocumentSource(makeFetch(calls, () => ({ id: 'a1', name: `Actor v${version}` })));

    // Observe so a write-through invalidation forces a refresh.
    source.subscribe('Actor', 'a1', () => {});
    await source.refresh('Actor', 'a1');

    const beforePatch = calls.length;
    version = 2;
    await source.mutate('Actor').patch('a1', { 'system.hp.value': 5 });
    await tick();

    // patch hits the update endpoint and then invalidates → a re-read.
    const patchCall = calls[beforePatch];
    assert.ok(patchCall.url.endsWith('/api/actors/a1/update'), 'patch posts to the actor update endpoint');
    assert.equal(source.getSnapshot<{ name: string }>('Actor', 'a1').data?.name, 'Actor v2', 'cache refreshed after mutation');
}

async function runNotFound() {
    const calls: FetchCall[] = [];
    const source = createClientDocumentSource(makeFetch(calls, () => ({}), 404));
    await source.refresh('Actor', 'missing');
    const snap = source.getSnapshot('Actor', 'missing');
    assert.equal(snap.notFound, true);
    assert.equal(snap.data, null);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('document-source.test.ts passed'))
        .catch((error) => { console.error(error); process.exit(1); });
}
