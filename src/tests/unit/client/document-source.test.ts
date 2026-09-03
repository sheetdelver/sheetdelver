import { strict as assert } from 'node:assert';
import {
    createClientDocumentSource,
    getClientDocumentSource,
    resetClientDocumentSource,
} from '@client/ui/sdk/createClientDocumentSource';

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

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempts = 0; attempts < 20; attempts += 1) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Timed out waiting for asynchronous document-source work');
}

export async function run() {
    await runReadDedupAndSnapshot();
    await runSubscribeAndInvalidate();
    await runInvalidateDuringFlightQueuesTrailingRead();
    await runMutationInvalidates();
    await runNotFound();
    await runResetDuringFlightCharacterization();
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

async function runInvalidateDuringFlightQueuesTrailingRead() {
    const responses: Array<(response: Response) => void> = [];
    const calls: FetchCall[] = [];
    const source = createClientDocumentSource(async (url, init) => {
        calls.push({ url, init });
        return new Promise<Response>((resolve) => responses.push(resolve));
    });
    source.subscribe('Actor', 'a1', () => undefined);

    const request = source.refresh('Actor', 'a1');
    source.invalidate('Actor', 'a1');
    assert.equal(calls.length, 1, 'invalidation does not start a parallel read');

    responses[0]({
        ok: true,
        status: 200,
        json: async () => ({ id: 'a1', name: 'Stale Actor' }),
    } as Response);
    await waitFor(() => calls.length === 2);
    assert.equal(calls.length, 2, 'invalidation queues one trailing read');

    responses[1]({
        ok: true,
        status: 200,
        json: async () => ({ id: 'a1', name: 'Fresh Actor' }),
    } as Response);
    await request;
    assert.equal(
        source.getSnapshot<{ name: string }>('Actor', 'a1').data?.name,
        'Fresh Actor',
        'the post-invalidation read becomes the final snapshot',
    );
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

async function runResetDuringFlightCharacterization() {
    type DeferredResponse = {
        promise: Promise<Response>;
        resolve: (value: Response) => void;
    };

    let resolveResponse!: DeferredResponse['resolve'];
    const responsePromise = new Promise<Response>((resolve) => {
        resolveResponse = resolve;
    });

    resetClientDocumentSource();
    const source = getClientDocumentSource(async () => responsePromise);
    let notifications = 0;
    source.subscribe('Actor', 'reset-race', () => {
        notifications += 1;
    });

    const request = source.refresh('Actor', 'reset-race');
    const notificationsBeforeReset = notifications;
    resetClientDocumentSource();

    // This assertion records the current reset gap. Phase 2/3 must invert it:
    // reset should notify mounted subscribers and invalidate the old epoch.
    assert.equal(notifications, notificationsBeforeReset);

    resolveResponse({
        ok: true,
        status: 200,
        json: async () => ({ id: 'reset-race', name: 'Previous World Actor' }),
    } as Response);
    await request;

    // The old request currently recreates an entry after reset. Keeping this
    // explicit makes stale-world resurrection measurable before remediation.
    assert.equal(
        source.getSnapshot<{ name: string }>('Actor', 'reset-race').data?.name,
        'Previous World Actor',
    );
    resetClientDocumentSource();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('document-source.test.ts passed'))
        .catch((error) => { console.error(error); process.exit(1); });
}
