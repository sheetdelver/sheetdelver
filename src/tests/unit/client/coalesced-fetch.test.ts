import { strict as assert } from 'node:assert';
import { createCoalescedFetch } from '@client/ui/context/coalescedFetch';

/**
 * Exercises the trailing-refetch guarantee (ADR-0028 / CMB-05): an
 * invalidation delivered while a fetch is unresolved must always cause one
 * later fresh fetch, so a pre-change snapshot can't become the final state.
 */

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

export async function run() {
    await runInvalidationDuringFlightTriggersTrailingFetch();
    await runQuietFetchRunsOnce();
    await runBurstCoalescesIntoSingleTrailingFetch();
    await runConcurrentReadDedupDoesNotQueueTrailingFetch();
    console.log('  - createCoalescedFetch: all checks passed');
}

async function runInvalidationDuringFlightTriggersTrailingFetch() {
    const deferreds: Array<ReturnType<typeof createDeferred<string>>> = [];
    let fetchCount = 0;
    const fetcher = createCoalescedFetch<string>(() => {
        fetchCount += 1;
        const deferred = createDeferred<string>();
        deferreds.push(deferred);
        return deferred.promise;
    });

    const first = fetcher();
    assert.equal(fetchCount, 1);

    // Invalidation arrives while the first request is unresolved — it captured
    // a pre-change snapshot, so it must not be the last word.
    const second = fetcher();
    assert.equal(second, first, 'in-flight callers share the same promise');
    assert.equal(fetchCount, 1, 'no parallel request is started');

    deferreds[0].resolve('stale-snapshot');
    await Promise.resolve();
    assert.equal(fetchCount, 2, 'a trailing fetch starts after the stale request settles');

    deferreds[1].resolve('fresh-snapshot');
    assert.equal(await first, 'fresh-snapshot', 'callers observe the trailing (fresh) result');
}

async function runQuietFetchRunsOnce() {
    let fetchCount = 0;
    const fetcher = createCoalescedFetch<string>(async () => {
        fetchCount += 1;
        return 'result';
    });

    assert.equal(await fetcher(), 'result');
    assert.equal(fetchCount, 1, 'no trailing fetch without an in-flight invalidation');

    // A later call starts a fresh request rather than reusing the settled one.
    assert.equal(await fetcher(), 'result');
    assert.equal(fetchCount, 2);
}

async function runBurstCoalescesIntoSingleTrailingFetch() {
    const deferreds: Array<ReturnType<typeof createDeferred<number>>> = [];
    let fetchCount = 0;
    const fetcher = createCoalescedFetch<number>(() => {
        fetchCount += 1;
        const deferred = createDeferred<number>();
        deferreds.push(deferred);
        return deferred.promise;
    });

    const request = fetcher();
    fetcher();
    fetcher();
    fetcher();
    assert.equal(fetchCount, 1, 'burst during flight starts nothing extra');

    deferreds[0].resolve(1);
    await Promise.resolve();
    assert.equal(fetchCount, 2, 'one trailing fetch covers the whole burst');

    deferreds[1].resolve(2);
    assert.equal(await request, 2);
    assert.equal(fetchCount, 2, 'no further fetches after the trailing one settles');
}

async function runConcurrentReadDedupDoesNotQueueTrailingFetch() {
    const deferred = createDeferred<string>();
    let fetchCount = 0;
    const fetcher = createCoalescedFetch<string>(() => {
        fetchCount += 1;
        return deferred.promise;
    });

    const first = fetcher.dedupe();
    const second = fetcher.dedupe();
    assert.equal(second, first, 'concurrent reads share the active promise');
    deferred.resolve('snapshot');
    assert.equal(await first, 'snapshot');
    assert.equal(fetchCount, 1, 'dedup-only callers do not queue a trailing fetch');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('coalesced-fetch.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
