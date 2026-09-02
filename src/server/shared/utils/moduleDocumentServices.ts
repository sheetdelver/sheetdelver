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
    ChatRuntime,
    ChatPostOptions,
} from '@shared/sdk/runtime';
import { SdkError, isSdkError, simulateTableDraw } from '@shared/sdk';
import { awaitWorldReady } from '@server/shared/utils/worldReadiness';
import type { RouteFoundryClient } from '@server/shared/types/requestContext';
import { parseDocumentUuid } from '@server/services/documents';
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
    /** Ownership predicate — false for missing docs and for denied access (fail-closed). */
    canReadDocument(id: string, subject: DocumentAccessSubject, minOwnership?: ResolvedDocumentOwnershipLevel): boolean;
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

const LIMITED_PROJECTION_KEYS = [
    '_id',
    'id',
    'uuid',
    'name',
    'type',
    'img',
    'folder',
    'sort',
    'ownership',
] as const;

function getDocumentId(document: Record<string, unknown>): string | null {
    const id = document._id ?? document.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * A LIMITED ownership match permits discovery, not a raw cache clone. Keep the
 * generic projection deliberately small; system-defined Actor details belong in
 * the adapter's ActorCard projection rather than this cross-system SDK surface.
 */
function projectLimitedDocument(document: Record<string, unknown>): Record<string, unknown> {
    const projected: Record<string, unknown> = {};
    for (const key of LIMITED_PROJECTION_KEYS) {
        if (document[key] !== undefined) projected[key] = document[key];
    }
    return projected;
}

function projectDetailDocument(
    type: string,
    document: Record<string, unknown>,
    subject: DocumentAccessSubject,
): Record<string, unknown> {
    if (type !== 'JournalEntry') return document;
    const id = getDocumentId(document);
    return {
        ...document,
        // Entry ownership does not imply visibility of every embedded page.
        pages: id ? journalStore.visiblePages(id, subject, DOCUMENT_VISIBILITY.DETAIL_VISIBLE) : [],
    };
}

function defaultListVisibility(type: string): ResolvedDocumentOwnershipLevel {
    // Foundry does not place LIMITED journals in the journal directory.
    return type === 'JournalEntry'
        ? DOCUMENT_VISIBILITY.DETAIL_VISIBLE
        : DOCUMENT_VISIBILITY.LIST_VISIBLE;
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

// World documents whose creation Foundry gates on the `author` field: a non-GM may only
// create one authored by themselves. Because the SDK dispatches the raw document straight to
// Foundry's backend (bypassing the client-side `author = game.user` default), a player-bound
// create with no author is denied. Default `author` to the acting user for these types; a
// module may set `author`/`user` explicitly to override (e.g. a GM/system message).
const AUTHOR_BEARING_TYPES = new Set(['ChatMessage', 'Macro']);

function withDefaultAuthor(type: string, data: unknown, userId: string | null): Record<string, unknown> {
    const record = (data ?? {}) as Record<string, unknown>;
    if (!userId || !AUTHOR_BEARING_TYPES.has(type)) return record;
    if (record.author !== undefined || record.user !== undefined) return record;
    return { ...record, author: userId };
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
    /** Block until the world is ready before an op (route only; base/bootstrap omits it). */
    ensureReady?: () => Promise<void>;
}

/** Shared read surface; subject behavior is injected (base = none, route = caller). */
function makeReads(deps: ReaderDeps): ReadonlyDocumentStore {
    // Scoped (route) mode: a real subject MUST resolve; a null subject fails closed
    // (decision 10 — "Reads fail closed when no access context can be resolved").
    // Privileged (base/adapter bootstrap) mode: no acting user, reads run system-level.
    const scoped = Boolean(deps.getSubject);
    const ensureReady = deps.ensureReady ?? (async () => {});
    const resolveSubject = (opts?: DocumentOpOptions): DocumentAccessSubject | undefined => {
        if (!scoped) return undefined;
        const subject = deps.getSubject!(opts);
        if (!subject) throw new SdkError('permission_denied', 'No access context could be resolved for this request');
        return subject;
    };
    return {
        async get(type, id, opts) {
            await ensureReady();
            const store = requireStore(type);
            const subject = resolveSubject(opts);
            if (!subject) return store.get(id) ?? null;
            const threshold = resolveMinOwnership(opts?.minOwnership, DOCUMENT_VISIBILITY.DETAIL_VISIBLE);
            const document = store.get(id, { subject, minOwnership: threshold });
            if (!document) return null;
            return store.canReadDocument(id, subject, DOCUMENT_VISIBILITY.DETAIL_VISIBLE)
                ? projectDetailDocument(type, document, subject)
                : projectLimitedDocument(document);
        },
        async list(type, query, opts) {
            await ensureReady();
            const store = requireStore(type);
            const subject = resolveSubject(opts);
            const requested = resolveMinOwnership(opts?.minOwnership, defaultListVisibility(type));
            // A caller may request a stricter threshold, but cannot lower the
            // document-specific journal directory floor below OBSERVER.
            const threshold = type === 'JournalEntry'
                ? Math.max(requested, DOCUMENT_VISIBILITY.DETAIL_VISIBLE) as ResolvedDocumentOwnershipLevel
                : requested;
            const rows = subject
                ? store.list({ subject, minOwnership: threshold }).map((document) => {
                    if (type === 'JournalEntry') return projectLimitedDocument(document);
                    const id = getDocumentId(document);
                    return id && store.canReadDocument(id, subject, DOCUMENT_VISIBILITY.DETAIL_VISIBLE)
                        ? projectDetailDocument(type, document, subject)
                        : projectLimitedDocument(document);
                })
                : store.list();
            return applyQuery(rows, query);
        },
        async fetchByUuid(uuid, opts) {
            await ensureReady();
            if (!deps.fetchByUuid) {
                throw new SdkError('not_ready', 'fetchByUuid is not available on the base (adapter) runtime');
            }
            resolveSubject(opts);
            return deps.fetchByUuid(uuid);
        },
    };
}

/**
 * Read-only document surface for the adapter's base runtime (ADR-0027 decision 14).
 * Reads are system-level (no acting user).
 */
export function createReadonlyDocumentStore(deps: {
    fetchByUuid?: (uuid: string) => Promise<Record<string, unknown> | null>;
} = {}): ReadonlyDocumentStore {
    return makeReads({ fetchByUuid: deps.fetchByUuid });
}

/**
 * Full document surface for a route's `req.runtime` (ADR-0027 decisions 5/6/9), backed by
 * the request's `RouteFoundryClient`. Reads are subject-scoped to the caller (or `{ access }`
 * override); writes dispatch through the caller's transport, so any write-time `{ access }`
 * override must match that transport user. The socket never leaves core — modules only see
 * this typed surface.
 */
export function createDocumentStore(
    client: RouteFoundryClient,
    ensureReady: () => Promise<void> = awaitWorldReady,
): DocumentStore {
    const c = client as unknown as {
        userId: string;
        dispatchDocument(type: string, action: string, operation?: unknown, parent?: { type: string; id: string }): Promise<unknown>;
        fetchByUuid(uuid: string): Promise<unknown>;
    };

    const subjectFor = (opts?: DocumentOpOptions): DocumentAccessSubject | undefined => {
        const userId = opts?.access?.userId ?? c.userId;
        return userStore.createAccessSubject(userId) ?? undefined;
    };

    const reads = makeReads({
        getSubject: subjectFor,
        fetchByUuid: (uuid) => c.fetchByUuid(uuid) as Promise<Record<string, unknown> | null>,
        ensureReady,
    });
    const one = (r: unknown): Record<string, unknown> => {
        const res = r as { result?: Record<string, unknown>[] } | Record<string, unknown>;
        return ((res as { result?: Record<string, unknown>[] })?.result?.[0] ?? res) as Record<string, unknown>;
    };

    // Writes block until the world is ready (decision 25) and fail closed (decisions 9/10):
    // a real acting subject must resolve, and for ops targeting an existing document it must
    // hold OWNER-level (WRITEABLE) ownership. `canReadDocument` returns false for missing docs
    // and unresolved ownership, so unknown/ambiguous ownership blocks rather than warning.
    const requireSubject = async (opts?: DocumentOpOptions): Promise<DocumentAccessSubject> => {
        await ensureReady();
        const subject = subjectFor(opts);
        if (!subject) throw new SdkError('permission_denied', 'No access context could be resolved for this request');
        return subject;
    };
    const requireWriteSubject = async (opts?: DocumentOpOptions): Promise<DocumentAccessSubject> => {
        await ensureReady();
        if (opts?.access?.userId !== undefined && opts.access.userId !== c.userId) {
            throw new SdkError(
                'permission_denied',
                `Write denied: access override user ${opts.access.userId} does not match bound transport user ${c.userId ?? 'unknown'}`
            );
        }
        const subject = subjectFor(opts);
        if (!subject) throw new SdkError('permission_denied', 'No access context could be resolved for this request');
        return subject;
    };
    const assertWriteable = async (type: string, id: string, opts?: DocumentOpOptions): Promise<void> => {
        const subject = await requireWriteSubject(opts);
        if (!requireStore(type).canReadDocument(id, subject, DOCUMENT_VISIBILITY.WRITEABLE)) {
            throw new SdkError('permission_denied', `Write denied: user ${subject.userId} lacks owner-level access to ${type} ${id}`);
        }
    };
    // Embedded parents are addressed by Foundry uuid (`type.id`): `Actor.x` for a top-level
    // document, or the deeper `Actor.x.Item.y` for a document owned by another (an effect/item
    // on an owned item, etc.). The transport (`dispatchDocument` → `parentUuid`) resolves any
    // depth; the only gate is ownership. We check the WRITEABLE access of the ROOT document
    // (the first `type.id` pair) — you may mutate an embedded child iff you can write the
    // top-level document that ultimately owns it. This keeps embedded manipulation general
    // (effects on owned items today, other nested members tomorrow) without per-type stores.
    const assertParentWriteable = async (parent: { type: string; id: string }, opts?: DocumentOpOptions): Promise<void> => {
        const [rootType, rootId] = `${parent.type}.${parent.id}`.split('.');
        await assertWriteable(rootType, rootId, opts);
    };
    const getVisibleDocument = async (type: string, id: string, opts?: DocumentOpOptions): Promise<Record<string, unknown> | null> => {
        try {
            return await reads.get(type, id, opts);
        } catch (error: unknown) {
            if (isSdkError(error) && error.code === 'not_found') return null;
            throw error;
        }
    };
    const fetchByUuid = async (uuid: string, opts?: DocumentOpOptions): Promise<Record<string, unknown> | null> => {
        await ensureReady();
        const parsed = parseDocumentUuid(uuid);
        if (!parsed) return null;

        if (parsed.kind === 'world') {
            return getVisibleDocument(parsed.documentType, parsed.documentId, opts);
        }

        if (parsed.kind === 'embedded-world') {
            // Embedded contents always require full root visibility, even when a
            // caller explicitly asks for a LIMITED top-level projection.
            const detailOpts: DocumentOpOptions = { ...opts, minOwnership: 'observer' };
            const root = await getVisibleDocument(parsed.root.type, parsed.root.id, detailOpts);
            if (!root) return null;

            // Journal pages have independent ownership beneath the readable entry.
            const subject = await requireSubject(opts);
            const firstChild = parsed.path[0];
            if (parsed.root.type === 'JournalEntry'
                && firstChild?.type === 'JournalEntryPage'
                && !journalStore.canReadPage(parsed.root.id, firstChild.id, subject, DOCUMENT_VISIBILITY.DETAIL_VISIBLE)) {
                return null;
            }
            return c.fetchByUuid(parsed.raw) as Promise<Record<string, unknown> | null>;
        }

        // Compendium UUIDs are read-only and resolver-backed; still require a caller
        // context on route runtime so reads fail closed when no subject can resolve.
        await requireSubject(opts);
        return c.fetchByUuid(parsed.raw) as Promise<Record<string, unknown> | null>;
    };

    return {
        ...reads,
        fetchByUuid,
        create: async (type, data, opts) => {
            const subject = await requireWriteSubject(opts);
            requireStore(type);
            return one(await c.dispatchDocument(type, 'create', { data: [withDefaultAuthor(type, data, subject.userId)] }));
        },
        patch: async (type, id, updates, opts) => {
            await assertWriteable(type, id, opts);
            return one(await c.dispatchDocument(type, 'update', { updates: [{ _id: id, ...updates }] }));
        },
        upsert: async (type, data, opts) => {
            const subject = await requireWriteSubject(opts);
            const id = (data as { _id?: string })._id;
            const exists = id ? requireStore(type).get(id) : null;
            if (exists) {
                if (!requireStore(type).canReadDocument(id!, subject, DOCUMENT_VISIBILITY.WRITEABLE)) {
                    throw new SdkError('permission_denied', `Write denied: user ${subject.userId} lacks owner-level access to ${type} ${id}`);
                }
                return one(await c.dispatchDocument(type, 'update', { updates: [data] }));
            }
            return one(await c.dispatchDocument(type, 'create', { data: [withDefaultAuthor(type, data, subject.userId)] }));
        },
        delete: async (type, id, opts) => {
            await assertWriteable(type, id, opts);
            await c.dispatchDocument(type, 'delete', { ids: [id] });
        },
        commit: async (type, ops, opts) => {
            // Verify EVERY op before dispatching ANY — no privileged batch path bypasses
            // the per-document check (decision 10).
            const subject = await requireWriteSubject(opts);
            requireStore(type);
            const plan = ops.map(op => {
                const action = (op as { action?: string }).action ?? ((op as { _id?: string })._id ? 'update' : 'create');
                const id = (op as { _id?: string })._id;
                if (action === 'update' || action === 'delete') {
                    if (!id) throw new SdkError('validation', `commit ${action} requires an _id`);
                    if (!requireStore(type).canReadDocument(id, subject, DOCUMENT_VISIBILITY.WRITEABLE)) {
                        throw new SdkError('permission_denied', `Write denied: user ${subject.userId} lacks owner-level access to ${type} ${id}`);
                    }
                }
                return { op, action, id };
            });
            const results: Record<string, unknown>[] = [];
            for (const { op, action, id } of plan) {
                const payload = action === 'delete' ? { ids: [id] }
                    : action === 'update' ? { updates: [op] }
                        : { data: [withDefaultAuthor(type, op, subject.userId)] };
                results.push(one(await c.dispatchDocument(type, action, payload)));
            }
            return results;
        },
        effects: {
            create: async (parent, data, opts) => {
                await assertParentWriteable(parent, opts);
                return one(await c.dispatchDocument('ActiveEffect', 'create', { data: [data] }, parent));
            },
            update: async (parent, effectId, updates, opts) => {
                await assertParentWriteable(parent, opts);
                return one(await c.dispatchDocument('ActiveEffect', 'update', { updates: [{ _id: effectId, ...updates }] }, parent));
            },
            delete: async (parent, effectId, opts) => {
                await assertParentWriteable(parent, opts);
                await c.dispatchDocument('ActiveEffect', 'delete', { ids: [effectId] }, parent);
            },
        },
        items: {
            create: async (parent, data, opts) => {
                await assertParentWriteable(parent, opts);
                return one(await c.dispatchDocument('Item', 'create', { data: [data] }, parent));
            },
            update: async (parent, itemId, updates, opts) => {
                await assertParentWriteable(parent, opts);
                return one(await c.dispatchDocument('Item', 'update', { updates: [{ _id: itemId, ...updates }] }, parent));
            },
            delete: async (parent, itemId, opts) => {
                await assertParentWriteable(parent, opts);
                await c.dispatchDocument('Item', 'delete', { ids: [itemId] }, parent);
            },
        },
    };
}

/** Roll primitive backed by the request client (structured result, no forced chat). */
export function createRollRuntime(
    client: RouteFoundryClient,
    ensureReady: () => Promise<void> = awaitWorldReady,
): RollRuntime {
    const c = client as unknown as { roll(formula: string, label?: string, options?: unknown): Promise<Record<string, unknown>> };
    return {
        roll: async (formula, label, options) => {
            await ensureReady();
            const res = await c.roll(formula, label ?? '', { ...options, displayChat: options?.displayChat ?? false });
            const total = (res.rollTotal ?? res.total ?? 0) as number;
            return { formula, total, ...res };
        },
    };
}

/** RollTable draw primitive (fetch the table, then simulate the draw). */
export function createTableRuntime(
    documents: Pick<DocumentStore, 'fetchByUuid'>,
    ensureReady: () => Promise<void> = awaitWorldReady,
): TableRuntime {
    return {
        draw: async (uuid, options) => {
            await ensureReady();
            const table = await documents.fetchByUuid(uuid);
            if (!table) throw new SdkError('not_found', `RollTable not found: ${uuid}`);
            return simulateTableDraw(table, {
                rollOverride: options?.rollOverride,
                fetchDocument: async (u) => {
                    try { return await documents.fetchByUuid(u); } catch { return null; }
                },
            });
        },
    };
}

/** Chat primitive backed by the request client (post a message / card / default item-use card). */
export function createChatRuntime(
    client: RouteFoundryClient,
    ensureReady: () => Promise<void> = awaitWorldReady,
): ChatRuntime {
    const c = client as unknown as {
        userId: string;
        createChatMessage(data: Record<string, unknown>): Promise<unknown>;
        useItem(actorId: string, itemId: string): Promise<unknown>;
    };

    // Apply rollMode visibility (whisper/blind) to a message. Any explicit whisper/blind on
    // the message overrides the rollMode-derived value (manual targeting wins).
    const applyVisibility = async (
        message: Record<string, unknown>,
        options?: ChatPostOptions,
    ): Promise<Record<string, unknown>> => {
        const out: Record<string, unknown> = { ...message };
        // Default the message author to the acting user. We dispatch the raw document
        // straight to Foundry's backend (bypassing the client-side `author = game.user`
        // default), and a non-GM may only create a ChatMessage authored by themselves —
        // without this, player-triggered module chat is denied. A module may still set
        // `author` explicitly to override (e.g. a GM/system message).
        if (out.author === undefined && out.user === undefined) out.author = c.userId;
        if (options?.speaker && out.speaker === undefined) out.speaker = options.speaker;
        if (options?.rollMode) {
            const { resolveRollModeData } = await import('@server/core/documents/primary/chat-messages/chatMessagePayload');
            const modeData = await resolveRollModeData(options.rollMode, c.userId, () => userStore.getGmUserIds());
            // rollMode sets defaults; explicit message fields override (manual targeting wins).
            return { ...modeData, ...out };
        }
        return out;
    };

    return {
        send: async (message, options) => {
            await ensureReady();
            return c.createChatMessage(await applyVisibility(message, options));
        },
        card: async (card, options) => {
            await ensureReady();
            // Serialize the structured ChatCard into a ChatMessage: the rendered body goes
            // to `content`, and the full card rides a flag so a client renderer (decision 28
            // componentStyles.chat) can present rolls/buttons richly. Modules that pre-render
            // HTML pass it as `card.content`.
            const message: Record<string, unknown> = {
                content: String(card.content ?? card.flavor ?? card.title ?? ''),
                flags: { sheetDelver: { chatCard: card } },
            };
            if (card.flavor) message.flavor = card.flavor;
            if (Array.isArray(card.rolls) && card.rolls.length) message.rolls = card.rolls;
            return c.createChatMessage(await applyVisibility(message, options));
        },
        useItem: async (actorId, itemId) => {
            await ensureReady();
            return c.useItem(actorId, itemId);
        },
    };
}

/**
 * Assemble the per-request `req.runtime` from the read-only base + the request's client.
 * The base (logger/dataStore/compendium/foundryUrl/moduleId) is reused; document/roll/table/
 * chat services are bound to the caller's transport. `ensureReady` (default `awaitWorldReady`)
 * is injectable for tests.
 */
export function createModuleRequestRuntime(
    base: ModuleRuntime,
    client: RouteFoundryClient,
    ensureReady: () => Promise<void> = awaitWorldReady,
): ModuleRequestRuntime {
    const documents = createDocumentStore(client, ensureReady);
    return {
        ...base,
        documents,
        rolls: createRollRuntime(client, ensureReady),
        tables: createTableRuntime(documents, ensureReady),
        chat: createChatRuntime(client, ensureReady),
    };
}
