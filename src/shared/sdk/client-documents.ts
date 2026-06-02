import type { SdkErrorCode } from './errors';

/**
 * Client-side document data API (ADR-0027 decisions 17 / 25).
 *
 * Hooks (`useDocument` / `useDocumentMutation` / `useActorSheet`) are the only
 * module-facing data API. They are thin React wrappers over a **host-owned cache**
 * that the platform supplies through `SDKContextValue.documents`. The cache dedups
 * concurrent reads of the same document across surfaces (keyed by `type + id`), so a
 * dashboard card and an open sheet reading the same actor resolve to one fetch, and a
 * realtime change invalidates the key and refreshes every mounted surface from the
 * single source. Modules never see the cache, the transport, or a query library.
 */

/** Structured read/write failure surfaced to a hook (mirrors the server SdkError shape). */
export interface ClientDocumentError {
    code: SdkErrorCode;
    message: string;
    status: number;
}

/**
 * Immutable snapshot of a single cached document. The host MUST return a stable
 * reference while the value is unchanged (React `useSyncExternalStore` contract);
 * a new object is produced only when the entry actually changes.
 */
export interface DocumentSnapshot<T = unknown> {
    data: T | null;
    loading: boolean;
    notFound: boolean;
    error: ClientDocumentError | null;
}

/**
 * Write surface for a document type, mirroring the server `DocumentStore` (decision 17).
 * Writes are host-routed (they go through the platform REST surface and the caller's
 * identity); on success the host invalidates the affected cache key so subscribers refresh.
 */
export interface ClientDocumentMutations {
    create(data: Record<string, unknown>): Promise<unknown>;
    patch(id: string, updates: Record<string, unknown>): Promise<unknown>;
    delete(id: string): Promise<void>;
    /** Embedded sub-document (item / ActiveEffect) mutations under a parent document. */
    embedded: {
        create(parentId: string, data: Record<string, unknown>): Promise<unknown>;
        update(parentId: string, childId: string, updates: Record<string, unknown>): Promise<unknown>;
        delete(parentId: string, childId: string): Promise<void>;
    };
}

/**
 * The host-owned document source injected on `SDKContextValue.documents`. The read
 * half is `useSyncExternalStore`-shaped (`getSnapshot` + `subscribe`); `refresh` triggers
 * a deduped fetch, `invalidate` drops a key, and `mutate` returns the typed write surface.
 */
export interface ClientDocumentSource {
    /** Current cached snapshot for `type:id` (stable reference until it changes). */
    getSnapshot<T = unknown>(type: string, id: string): DocumentSnapshot<T>;
    /** Subscribe to changes of `type:id`; returns an unsubscribe function. */
    subscribe(type: string, id: string, onStoreChange: () => void): () => void;
    /** Trigger (or join an in-flight) fetch for `type:id`, updating the cache. */
    refresh(type: string, id: string): Promise<void>;
    /** Drop the cached entry for `type:id` and notify subscribers (forces a re-fetch). */
    invalidate(type: string, id: string): void;
    /** Typed write surface for a document type. */
    mutate(type: string): ClientDocumentMutations;
}
