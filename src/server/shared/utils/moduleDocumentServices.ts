/**
 * Server-side backing for `ModuleRuntime.documents` (ADR-0027 decisions 5/6).
 *
 * This slice implements the **read-only** surface (`ReadonlyDocumentStore`) used by the
 * adapter's base runtime — type-keyed reads over the mounted primary-document store
 * singletons, plus UUID resolution. The full write surface (`DocumentStore` on a route's
 * `req.runtime`) is wired with the dispatch rewrite.
 *
 * Reads here are privileged/system-level (the base runtime has no acting user — adapters
 * are read-only and run at bootstrap). Route reads will pass the caller's subject.
 */
import type {
    ReadonlyDocumentStore,
    DocumentStore,
    DocumentQuery,
    DocumentListResult,
    DocumentOpOptions,
    ModuleOwnershipLevel,
    ModuleRuntime,
    ModuleRequestRuntime,
    RollRuntime,
    TableRuntime,
} from '@shared/sdk';
import { SdkError, simulateTableDraw } from '@shared/sdk';
import type { RouteFoundryClient } from '@server/shared/types/requestContext';
import {
    DocumentOwnershipLevel,
    DOCUMENT_VISIBILITY,
    type DocumentAccessSubject,
    type ResolvedDocumentOwnershipLevel,
} from '@server/core/documents/primary/base/ownership';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { itemStore } from '@server/core/documents/primary/items/ItemStore';
import { journalStore } from '@server/core/documents/primary/journals/JournalStore';
import { combatStore } from '@server/core/documents/primary/combats/CombatStore';
import { rollTableStore } from '@server/core/documents/primary/roll-tables/RollTableStore';
import { macroStore } from '@server/core/documents/primary/macros/MacroStore';
import { playlistStore } from '@server/core/documents/primary/playlists/PlaylistStore';
import { cardsStore } from '@server/core/documents/primary/cards/CardsStore';
import { folderStore } from '@server/core/documents/primary/folders/FolderStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { chatMessageStore } from '@server/core/documents/primary/chat-messages/ChatMessageStore';

/** Minimal shape every primary store exposes for read access (subject-scoped). */
interface ReadOpts { subject?: DocumentAccessSubject; minOwnership?: ResolvedDocumentOwnershipLevel }
interface ReadableStore {
    get(id: string, options?: ReadOpts): Record<string, unknown> | null;
    list(options?: ReadOpts): Record<string, unknown>[];
    isReady(): boolean;
}

/** Map the SDK ownership label to the internal resolved level. */
function resolveMinOwnership(level: ModuleOwnershipLevel | undefined, fallback: ResolvedDocumentOwnershipLevel): ResolvedDocumentOwnershipLevel {
    switch (level) {
        case 'limited': return DocumentOwnershipLevel.LIMITED;
        case 'observer': return DocumentOwnershipLevel.OBSERVER;
        case 'owner': return DocumentOwnershipLevel.OWNER;
        default: return fallback;
    }
}

/**
 * Type-keyed map of the implemented primary stores (ADR-0027 A8). Stub stores
 * (Scene, Adventure, Setting, FogExploration) are intentionally absent.
 */
const STORE_BY_TYPE: Record<string, ReadableStore> = {
    Actor: actorStore as unknown as ReadableStore,
    Item: itemStore as unknown as ReadableStore,
    JournalEntry: journalStore as unknown as ReadableStore,
    Combat: combatStore as unknown as ReadableStore,
    RollTable: rollTableStore as unknown as ReadableStore,
    Macro: macroStore as unknown as ReadableStore,
    Playlist: playlistStore as unknown as ReadableStore,
    Cards: cardsStore as unknown as ReadableStore,
    Folder: folderStore as unknown as ReadableStore,
    User: userStore as unknown as ReadableStore,
    ChatMessage: chatMessageStore as unknown as ReadableStore,
};

function requireStore(type: string): ReadableStore {
    const store = STORE_BY_TYPE[type];
    if (!store) throw new SdkError('not_found', `Unknown or unexposed document type: ${type}`);
    if (!store.isReady()) throw new SdkError('not_ready', `${type} store is not ready`);
    return store;
}

/** Apply the SDK `DocumentQuery` (filter/sort/page/limit) to an in-memory row set. */
function applyQuery(rows: Record<string, unknown>[], query?: DocumentQuery): DocumentListResult {
    let out = rows;
    if (query?.filter) {
        const entries = Object.entries(query.filter);
        out = out.filter(row => entries.every(([k, v]) => (row as Record<string, unknown>)[k] === v));
    }
    if (query?.sort) {
        const field = typeof query.sort === 'string' ? query.sort : query.sort.field;
        const dir = typeof query.sort === 'string' ? 'asc' : (query.sort.dir ?? 'asc');
        out = [...out].sort((a, b) => {
            const av = a[field] as never; const bv = b[field] as never;
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return dir === 'desc' ? -cmp : cmp;
        });
    }
    const total = out.length;
    if (query?.limit !== undefined) {
        out = out.slice(0, query.limit);
    } else if (query?.pageSize !== undefined) {
        const page = query.page ?? 0;
        out = out.slice(page * query.pageSize, page * query.pageSize + query.pageSize);
    }
    return { rows: out, total, page: query?.page };
}

interface ReaderDeps {
    /** Resolve the acting subject for an op (undefined = privileged/system read). */
    getSubject?: (opts?: DocumentOpOptions) => DocumentAccessSubject | undefined;
    fetchByUuid?: (uuid: string) => Promise<Record<string, unknown> | null>;
}

/** Shared read surface; subject behavior is injected (base = none, route = caller). */
function makeReads(deps: ReaderDeps): ReadonlyDocumentStore {
    const subjectFor = deps.getSubject ?? (() => undefined);
    return {
        async get(type, id, opts) {
            const store = requireStore(type);
            const subject = subjectFor(opts);
            if (!subject) return store.get(id) ?? null;
            return store.get(id, { subject, minOwnership: resolveMinOwnership(opts?.minOwnership, DOCUMENT_VISIBILITY.DETAIL_VISIBLE) }) ?? null;
        },
        async list(type, query, opts) {
            const store = requireStore(type);
            const subject = subjectFor(opts);
            const rows = subject
                ? store.list({ subject, minOwnership: resolveMinOwnership(opts?.minOwnership, DOCUMENT_VISIBILITY.LIST_VISIBLE) })
                : store.list();
            return applyQuery(rows, query);
        },
        async fetchByUuid(uuid) {
            if (!deps.fetchByUuid) {
                throw new SdkError('not_ready', 'fetchByUuid is not available on the base (adapter) runtime');
            }
            return deps.fetchByUuid(uuid);
        },
    };
}

/**
 * Read-only document surface for the adapter's base runtime (ADR-0027 decision 14).
 * Reads are system-level (no acting user); `fetchByUuid` is not wired on the base.
 */
export function createReadonlyDocumentStore(deps: {
    fetchByUuid?: (uuid: string) => Promise<Record<string, unknown> | null>;
} = {}): ReadonlyDocumentStore {
    return makeReads({ fetchByUuid: deps.fetchByUuid });
}

/**
 * Full document surface for a route's `req.runtime` (ADR-0027 decisions 5/6/9), backed by
 * the request's `RouteFoundryClient`. Reads are subject-scoped to the caller (or `{ access }`
 * override); writes dispatch through the caller's transport (Foundry attributes them to the
 * acting user). The socket never leaves core — modules only see this typed surface.
 */
export function createDocumentStore(client: RouteFoundryClient): DocumentStore {
    const c = client as unknown as {
        userId: string;
        dispatchDocument(type: string, action: string, operation?: unknown, parent?: { type: string; id: string }): Promise<unknown>;
        fetchByUuid(uuid: string): Promise<unknown>;
    };

    const subjectFor = (opts?: DocumentOpOptions): DocumentAccessSubject | undefined => {
        const userId = opts?.access?.userId ?? c.userId;
        return userStore.createAccessSubject(userId) ?? undefined;
    };

    const reads = makeReads({ getSubject: subjectFor, fetchByUuid: (uuid) => c.fetchByUuid(uuid) as Promise<Record<string, unknown> | null> });
    const one = (r: unknown): Record<string, unknown> => {
        const res = r as { result?: Record<string, unknown>[] } | Record<string, unknown>;
        return ((res as { result?: Record<string, unknown>[] })?.result?.[0] ?? res) as Record<string, unknown>;
    };

    return {
        ...reads,
        create: async (type, data) => one(await c.dispatchDocument(type, 'create', { data: [data] })),
        patch: async (type, id, updates) => one(await c.dispatchDocument(type, 'update', { updates: [{ _id: id, ...updates }] })),
        upsert: async (type, data) => {
            const id = (data as { _id?: string })._id;
            const exists = id ? requireStore(type).get(id) : null;
            return exists
                ? one(await c.dispatchDocument(type, 'update', { updates: [data] }))
                : one(await c.dispatchDocument(type, 'create', { data: [data] }));
        },
        delete: async (type, id) => { await c.dispatchDocument(type, 'delete', { ids: [id] }); },
        commit: async (type, ops) => {
            // Batched by action; each group is one dispatch. Each op may carry `action`.
            const results: Record<string, unknown>[] = [];
            for (const op of ops) {
                const action = (op as { action?: string }).action ?? ((op as { _id?: string })._id ? 'update' : 'create');
                const payload = action === 'delete' ? { ids: [(op as { _id?: string })._id] }
                    : action === 'update' ? { updates: [op] }
                        : { data: [op] };
                results.push(one(await c.dispatchDocument(type, action, payload)));
            }
            return results;
        },
        effects: {
            create: async (parent, data) => one(await c.dispatchDocument('ActiveEffect', 'create', { data: [data] }, parent)),
            update: async (parent, effectId, updates) => one(await c.dispatchDocument('ActiveEffect', 'update', { updates: [{ _id: effectId, ...updates }] }, parent)),
            delete: async (parent, effectId) => { await c.dispatchDocument('ActiveEffect', 'delete', { ids: [effectId] }, parent); },
        },
    };
}

/** Roll primitive backed by the request client (structured result, no forced chat). */
export function createRollRuntime(client: RouteFoundryClient): RollRuntime {
    const c = client as unknown as { roll(formula: string, label?: string, options?: unknown): Promise<Record<string, unknown>> };
    return {
        roll: async (formula, label, options) => {
            const res = await c.roll(formula, label ?? '', { ...options, displayChat: options?.displayChat ?? false });
            const total = (res.rollTotal ?? res.total ?? 0) as number;
            return { formula, total, ...res };
        },
    };
}

/** RollTable draw primitive (fetch the table, then simulate the draw). */
export function createTableRuntime(client: RouteFoundryClient): TableRuntime {
    const c = client as unknown as { fetchByUuid(uuid: string): Promise<Record<string, unknown>> };
    return {
        draw: async (uuid, options) => {
            const table = await c.fetchByUuid(uuid);
            if (!table) throw new SdkError('not_found', `RollTable not found: ${uuid}`);
            return simulateTableDraw(table, {
                rollOverride: options?.rollOverride,
                fetchDocument: async (u) => {
                    try { return (await c.fetchByUuid(u)) as Record<string, unknown>; } catch { return null; }
                },
            });
        },
    };
}

/**
 * Assemble the per-request `req.runtime` from the read-only base + the request's client.
 * The base (logger/dataStore/compendium/foundryUrl/moduleId) is reused; document/roll/table
 * services are bound to the caller's transport.
 */
export function createModuleRequestRuntime(base: ModuleRuntime, client: RouteFoundryClient): ModuleRequestRuntime {
    return {
        ...base,
        documents: createDocumentStore(client),
        rolls: createRollRuntime(client),
        tables: createTableRuntime(client),
    };
}
