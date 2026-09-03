'use client';

import type {
    ClientDocumentSource,
    ClientDocumentMutations,
    DocumentSnapshot,
    ClientDocumentError,
} from '@shared/sdk/client-documents';
import { createCoalescedFetch, type CoalescedFetch } from '@client/ui/context/coalescedFetch';

/**
 * Host-owned client document cache (ADR-0027 decisions 17/25).
 *
 * A single store, keyed by `type:id`, that backs every `useDocument` / `useActorSheet`
 * across all mounted surfaces. Concurrent reads of the same key share one in-flight
 * fetch (dedup), snapshots are stable references for `useSyncExternalStore`, and a
 * mutation or a realtime change invalidates the key so every subscriber refreshes from
 * the single source. Modules never touch this — they call the hooks.
 *
 * The transport is the platform actor REST surface (`/api/actors/...`), the only client
 * document API today; the type→endpoint map extends as more surfaces gain endpoints.
 */

type FetchWithAuth = (input: string, init?: RequestInit) => Promise<Response>;

interface DocumentEndpoints {
    read: (id: string) => string;
    create: () => string;
    update: (id: string) => string;
    remove: (id: string) => string;
    children: (id: string) => string;
}

const ENDPOINTS: Record<string, DocumentEndpoints> = {
    Actor: {
        read: (id) => `/api/actors/${id}`,
        create: () => `/api/actors`,
        update: (id) => `/api/actors/${id}/update`,
        remove: (id) => `/api/actors/${id}`,
        children: (id) => `/api/actors/${id}/items`,
    },
};

function endpointsFor(type: string): DocumentEndpoints {
    const cfg = ENDPOINTS[type];
    if (!cfg) {
        throw new Error(`[sdk] No client document endpoints registered for type "${type}"`);
    }
    return cfg;
}

const LOADING_SNAPSHOT: DocumentSnapshot = Object.freeze({ data: null, loading: true, notFound: false, error: null });

interface Entry {
    type: string;
    id: string;
    snapshot: DocumentSnapshot;
    listeners: Set<() => void>;
    fetcher: CoalescedFetch<void> | null;
}

function statusToError(status: number, message: string): ClientDocumentError {
    const code = status === 404 ? 'not_found'
        : status === 403 ? 'permission_denied'
            : status === 503 ? 'not_ready'
                : status === 0 ? 'not_ready'
                    : 'internal';
    return { code, message, status };
}

function createDocumentSource(getFetch: () => FetchWithAuth): {
    source: ClientDocumentSource;
    reset: (refreshObserved?: boolean) => void;
} {
    const entries = new Map<string, Entry>();
    let epoch = 0;
    const fetchWithAuth: FetchWithAuth = (input, init) => getFetch()(input, init);

    const keyFor = (type: string, id: string) => `${type}:${id}`;

    const ensureEntry = (key: string, type: string, id: string): Entry => {
        let entry = entries.get(key);
        if (!entry) {
            entry = { type, id, snapshot: LOADING_SNAPSHOT, listeners: new Set(), fetcher: null };
            entries.set(key, entry);
        }
        return entry;
    };

    const setSnapshot = (key: string, snapshot: DocumentSnapshot, requestEpoch: number) => {
        // A request from an older world/session must not recreate or update an
        // entry after reset. The entry lookup intentionally does not ensure.
        if (requestEpoch !== epoch) return;
        const entry = entries.get(key);
        if (!entry) return;
        entry.snapshot = snapshot;
        entry.listeners.forEach((listener) => listener());
    };

    const ensureFetcher = (type: string, id: string, key: string): CoalescedFetch<void> => {
        const entry = ensureEntry(key, type, id);
        if (entry.fetcher) return entry.fetcher;

        const cfg = endpointsFor(type);
        const fetcherEpoch = epoch;
        const isCurrentEpoch = () => fetcherEpoch === epoch && entries.get(key) === entry;
        // Ordinary reads use fetcher.dedupe(); invalidations call the fetcher
        // itself so a signal observed during an active read queues one trailing
        // authoritative read rather than accepting the older response.
        entry.fetcher = createCoalescedFetch<void>(async () => {
            if (!isCurrentEpoch()) return;
            setSnapshot(key, { ...entry.snapshot, loading: true, error: null }, fetcherEpoch);
            try {
                const res = await fetchWithAuth(cfg.read(id), { cache: 'no-store' });
                if (!isCurrentEpoch()) return;
                if (res.status === 404) {
                    setSnapshot(key, { data: null, loading: false, notFound: true, error: null }, fetcherEpoch);
                    return;
                }
                if (!res.ok) {
                    setSnapshot(key, {
                        data: entry.snapshot.data,
                        loading: false,
                        notFound: false,
                        error: statusToError(res.status, `Request failed (${res.status})`),
                    }, fetcherEpoch);
                    return;
                }
                const data = await res.json();
                if (!isCurrentEpoch()) return;
                if (data && !data.error) {
                    setSnapshot(key, { data, loading: false, notFound: false, error: null }, fetcherEpoch);
                } else {
                    setSnapshot(key, {
                        data: null,
                        loading: false,
                        notFound: false,
                        error: statusToError(res.status, data?.error ?? 'Unknown error'),
                    }, fetcherEpoch);
                }
            } catch (e) {
                if (!isCurrentEpoch()) return;
                setSnapshot(key, {
                    data: entry.snapshot.data,
                    loading: false,
                    notFound: false,
                    error: statusToError(0, e instanceof Error ? e.message : 'Connection error'),
                }, fetcherEpoch);
            }
        });
        return entry.fetcher;
    };

    const source: ClientDocumentSource = {
        getSnapshot<T = unknown>(type: string, id: string): DocumentSnapshot<T> {
            return ensureEntry(keyFor(type, id), type, id).snapshot as DocumentSnapshot<T>;
        },

        subscribe(type: string, id: string, onStoreChange: () => void): () => void {
            const entry = ensureEntry(keyFor(type, id), type, id);
            entry.listeners.add(onStoreChange);
            return () => { entry.listeners.delete(onStoreChange); };
        },

        refresh(type: string, id: string): Promise<void> {
            const key = keyFor(type, id);
            return ensureFetcher(type, id, key).dedupe() as Promise<void>;
        },

        invalidate(type: string, id: string): void {
            const key = keyFor(type, id);
            const entry = entries.get(key);
            if (!entry) return;
            // Mounted surfaces refresh from the single source; unobserved keys are dropped.
            if (entry.listeners.size > 0) {
                void ensureFetcher(type, id, key)();
            } else {
                entries.delete(key);
            }
        },

        mutate(type: string): ClientDocumentMutations {
            const cfg = endpointsFor(type);
            const send = (url: string, body: unknown, method = 'POST') =>
                fetchWithAuth(url, {
                    method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });

            return {
                create: async (data) => {
                    const res = await send(cfg.create(), data);
                    return res.json();
                },
                patch: async (id, updates) => {
                    const res = await send(cfg.update(id), updates);
                    const json = await res.json();
                    source.invalidate(type, id);
                    return json;
                },
                delete: async (id) => {
                    await fetchWithAuth(cfg.remove(id), { method: 'DELETE' });
                    source.invalidate(type, id);
                },
                embedded: {
                    create: async (parentId, data) => {
                        const res = await send(cfg.children(parentId), data);
                        const json = await res.json();
                        source.invalidate(type, parentId);
                        return json;
                    },
                    update: async (parentId, childId, updates) => {
                        const res = await send(cfg.children(parentId), { _id: childId, ...updates }, 'PUT');
                        const json = await res.json();
                        source.invalidate(type, parentId);
                        return json;
                    },
                    delete: async (parentId, childId) => {
                        await fetchWithAuth(`${cfg.children(parentId)}?itemId=${childId}`, { method: 'DELETE' });
                        source.invalidate(type, parentId);
                    },
                },
            };
        },
    };

    const reset = (refreshObserved = false) => {
        epoch += 1;
        const observed: Array<{ type: string; id: string }> = [];

        for (const [key, entry] of entries) {
            entry.fetcher = null;
            if (entry.listeners.size === 0) {
                entries.delete(key);
                continue;
            }

            // Preserve subscriptions across the epoch boundary. Mounted hooks
            // see the loading snapshot immediately and can be refreshed without
            // replacing the public source identity.
            entry.snapshot = LOADING_SNAPSHOT;
            entry.listeners.forEach((listener) => listener());
            if (refreshObserved) observed.push({ type: entry.type, id: entry.id });
        }

        for (const { type, id } of observed) {
            void source.refresh(type, id);
        }
    };

    return { source, reset };
}

/** Create an isolated document source (no shared singleton) — used by the app singleton and tests. */
export function createClientDocumentSource(fetchWithAuth: FetchWithAuth): ClientDocumentSource {
    return createDocumentSource(() => fetchWithAuth).source;
}

// App-level singleton (ADR-0027 decision 25): one cache shared across every surface so a
// dashboard card and an open sheet reading the same document resolve to a single fetch.
// The transport is swappable (token changes) and `reset` clears state on logout/world change.
let latestFetch: FetchWithAuth = async () => {
    throw new Error('[sdk] document source used before a transport was provided');
};
let singleton: {
    source: ClientDocumentSource;
    reset: (refreshObserved?: boolean) => void;
} | null = null;
let singletonScope: string | null | undefined;

export function getClientDocumentSource(fetchWithAuth: FetchWithAuth): ClientDocumentSource {
    latestFetch = fetchWithAuth;
    if (!singleton) singleton = createDocumentSource(() => latestFetch);
    return singleton.source;
}

/**
 * Bind the singleton to one authenticated world/user scope. Changing scope
 * advances its private epoch and refreshes every key that remains observed.
 */
export function setClientDocumentSourceScope(scope: string | null): void {
    if (singletonScope === scope) return;
    singletonScope = scope;
    singleton?.reset(scope !== null);
}

/** Retire the active scope without reading until another scope becomes active. */
export function resetClientDocumentSource(): void {
    singletonScope = null;
    singleton?.reset(false);
}
