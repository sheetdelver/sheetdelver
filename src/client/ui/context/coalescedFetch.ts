/**
 * In-flight fetch coalescing with a trailing-refetch guarantee
 * (ADR-0028 / audit finding CMB-05).
 *
 * A refetch requested while a fetch is in flight cannot simply be dropped
 * into the in-flight promise: that request may have captured a snapshot from
 * before the change that triggered the refetch, so the stale response would
 * become the final state. Instead, calls made while a fetch is in flight
 * return the in-flight promise but mark the fetcher dirty; when the current
 * fetch settles, one trailing fetch runs (repeating while further requests
 * arrive) so the last observed state always reflects a fetch started after
 * the last invalidation.
 */
export interface CoalescedFetch<TResult> {
    (): Promise<TResult | void>;
    /** Share an active request without treating the caller as an invalidation. */
    dedupe(): Promise<TResult | void>;
}

export function createCoalescedFetch<TResult>(
    fetchOnce: () => Promise<TResult | void>,
): CoalescedFetch<TResult> {
    let inFlight: Promise<TResult | void> | null = null;
    let refetchQueued = false;

    const invoke = (queueTrailing: boolean): Promise<TResult | void> => {
        if (inFlight) {
            if (queueTrailing) refetchQueued = true;
            return inFlight;
        }

        const request = (async () => {
            let result = await fetchOnce();
            while (refetchQueued) {
                refetchQueued = false;
                result = await fetchOnce();
            }
            return result;
        })();

        inFlight = request;
        void request.finally(() => {
            if (inFlight === request) inFlight = null;
        });
        return request;
    };

    // The callable form represents an invalidation request. Initial/concurrent
    // reads use `dedupe` so they share transport without manufacturing a
    // trailing fetch when no newer state was observed.
    const fetcher = (() => invoke(true)) as CoalescedFetch<TResult>;
    fetcher.dedupe = () => invoke(false);
    return fetcher;
}
