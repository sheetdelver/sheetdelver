// ---------------------------------------------------------------------------
// @sheet-delver/sdk/testing — mock host for contract tests (ADR-0027 decision 30).
//
// In-memory fakes of the server runtime and the client SDK context so a fixture
// module can be exercised against the PUBLIC SDK surface without a live platform:
// render a sheet, fetch/mutate through the runtime, roll, process a realtime change,
// resolve a declared compendium document, persist via DataStore, resolve an asset URL.
// ---------------------------------------------------------------------------

import { createElement } from 'react';
import type { ComponentType, ReactNode } from 'react';
import type {
    ModuleRequestRuntime,
    DocumentStore,
    RollResult,
} from './runtime';
import type { DrawResult } from './utils';
import { buildModuleAssetUrl } from './utils';
import { SDKContext, SDKComponentsContext } from './react';
import type { SDKContextValue, SDKComponentsValue } from './react';
import type { ClientDocumentSource, DocumentSnapshot } from './client-documents';
import type { SdkEvents, SdkSignal, SdkSignalHandler, SdkSignalPayloads } from './events';

type Doc = Record<string, unknown>;
type DocSeed = Record<string, Record<string, Doc>>; // type -> id -> document

export interface MockRuntimeOptions {
    moduleId?: string;
    foundryUrl?: string;
    /** Seed documents: `{ Actor: { a1: {...} } }`. */
    documents?: DocSeed;
    /** Seed compendium rows by type: `{ Item: [{...}] }`. */
    compendium?: Record<string, Doc[]>;
    /** Seed DataStore values. */
    dataStore?: Record<string, unknown>;
    /** Deterministic roll total (default: sum of the formula's integer literals or 0). */
    roll?: (formula: string) => number;
}

function matchesQuery(doc: Doc, query?: Record<string, unknown>): boolean {
    if (!query) return true;
    return Object.entries(query).every(([k, v]) => doc[k] === v);
}

/** Build an in-memory `ModuleRequestRuntime` for server-side contract tests. */
export function createMockModuleRuntime(opts: MockRuntimeOptions = {}): ModuleRequestRuntime {
    const store: DocSeed = structuredClone(opts.documents ?? {});
    const compendium = opts.compendium ?? {};
    const data = new Map<string, unknown>(Object.entries(opts.dataStore ?? {}));
    const rollTotal = opts.roll ?? ((formula: string) =>
        (formula.match(/\d+/g) ?? []).reduce((sum, n) => sum + Number(n), 0));

    const bucket = (type: string): Record<string, Doc> => (store[type] ??= {});
    let idCounter = 0;
    const nextId = () => `mock-${++idCounter}`;

    const documents: DocumentStore = {
        async get(type, id) { return bucket(type)[id] ?? null; },
        async list(type, query) {
            const rows = Object.values(bucket(type)).filter((d) => matchesQuery(d, query?.filter));
            return { rows, total: rows.length };
        },
        async fetchByUuid(uuid) {
            for (const type of Object.keys(store)) {
                for (const doc of Object.values(bucket(type))) {
                    if (doc.uuid === uuid || doc._id === uuid) return doc;
                }
            }
            return null;
        },
        async create(type, dataIn) {
            const id = String((dataIn as { _id?: string })._id ?? nextId());
            const doc = { ...dataIn, _id: id };
            bucket(type)[id] = doc;
            return doc;
        },
        async patch(type, id, updates) {
            const existing = bucket(type)[id] ?? { _id: id };
            const doc = { ...existing, ...updates, _id: id };
            bucket(type)[id] = doc;
            return doc;
        },
        async upsert(type, dataIn) {
            const id = String((dataIn as { _id?: string })._id ?? nextId());
            const doc = { ...(bucket(type)[id] ?? {}), ...dataIn, _id: id };
            bucket(type)[id] = doc;
            return doc;
        },
        async delete(type, id) { delete bucket(type)[id]; },
        async commit(type, ops) {
            const out: Doc[] = [];
            for (const op of ops) {
                const id = (op as { _id?: string })._id;
                const action = (op as { action?: string }).action ?? (id ? 'update' : 'create');
                if (action === 'delete' && id) { delete bucket(type)[id]; }
                else if (action === 'update' && id) { out.push(await documents.patch(type, id, op)); }
                else { out.push(await documents.create(type, op)); }
            }
            return out;
        },
        effects: {
            async create(parent, dataIn) { return documents.create(`${parent.type}.Effect`, dataIn); },
            async update(parent, effectId, updates) { return documents.patch(`${parent.type}.Effect`, effectId, updates); },
            async delete(parent, effectId) { return documents.delete(`${parent.type}.Effect`, effectId); },
        },
        items: {
            async create(parent, dataIn) { return documents.create(`${parent.type}.Item`, dataIn); },
            async update(parent, itemId, updates) { return documents.patch(`${parent.type}.Item`, itemId, updates); },
            async delete(parent, itemId) { return documents.delete(`${parent.type}.Item`, itemId); },
        },
    };

    return {
        moduleId: opts.moduleId ?? 'mock',
        foundryUrl: opts.foundryUrl ?? 'http://localhost:30000',
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        dataStore: {
            async get(key) { return (data.has(key) ? data.get(key) : null) as never; },
            async set(key, value) { data.set(key, value); },
            async delete(key) { data.delete(key); },
            async has(key) { return data.has(key); },
            async keys(prefix) {
                const all = [...data.keys()];
                return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
            },
        },
        compendium: {
            async findOne(type, query) { return (compendium[type] ?? []).find((d) => matchesQuery(d, query)) ?? null; },
            async findAll(type, query) { return (compendium[type] ?? []).filter((d) => matchesQuery(d, query)); },
            async getById(type, id) {
                return (compendium[type] ?? []).find((d) => d._id === id || d.id === id || d.uuid === id) ?? null;
            },
        },
        documents,
        rolls: {
            async roll(formula): Promise<RollResult> { return { formula, total: rollTotal(formula) }; },
        },
        tables: {
            async draw(uuid): Promise<DrawResult> { return { roll: 0, formula: '', results: [], items: [], table: { uuid } }; },
        },
        chat: {
            async send(message) { return documents.create('ChatMessage', message); },
            async card(card) { return documents.create('ChatMessage', { content: String(card.content ?? ''), flags: { sheetDelver: { chatCard: card } } }); },
            async useItem(actorId, itemId) { return { actorId, itemId, used: true }; },
        },
    };
}

// ---------------------------------------------------------------------------
// Client mock host (for rendering a fixture sheet)
// ---------------------------------------------------------------------------

const EMPTY_SNAPSHOT: DocumentSnapshot = Object.freeze({ data: null, loading: false, notFound: false, error: null });

/** In-memory `ClientDocumentSource` seeded with documents (`type -> id -> doc`). */
export function createMockDocumentSource(seed: DocSeed = {}): ClientDocumentSource {
    const snapshots = new Map<string, DocumentSnapshot>();
    const key = (type: string, id: string) => `${type}:${id}`;
    for (const [type, byId] of Object.entries(seed)) {
        for (const [id, doc] of Object.entries(byId)) {
            snapshots.set(key(type, id), { data: doc, loading: false, notFound: false, error: null });
        }
    }
    return {
        getSnapshot(type, id) { return (snapshots.get(key(type, id)) ?? EMPTY_SNAPSHOT) as never; },
        subscribe() { return () => {}; },
        async refresh() {},
        invalidate() {},
        mutate() {
            const noop = async () => ({});
            return { create: noop, patch: noop, delete: async () => {}, embedded: { create: noop, update: noop, delete: async () => {} } };
        },
    };
}

/** A controllable `SdkEvents` bus for testing realtime handlers. */
export function createMockSdkEvents(): SdkEvents & { emit<S extends SdkSignal>(signal: S, payload: SdkSignalPayloads[S]): void } {
    const listeners = new Map<SdkSignal, Set<(p: unknown) => void>>();
    return {
        on<S extends SdkSignal>(signal: S, handler: SdkSignalHandler<S>) {
            let set = listeners.get(signal);
            if (!set) { set = new Set(); listeners.set(signal, set); }
            const erased = handler as (p: unknown) => void;
            set.add(erased);
            return () => { set!.delete(erased); };
        },
        emit<S extends SdkSignal>(signal: S, payload: SdkSignalPayloads[S]) {
            listeners.get(signal)?.forEach((h) => h(payload));
        },
    };
}

export interface MockSdkContextOptions {
    moduleId?: string;
    worldId?: string;
    foundryUrl?: string;
    documents?: DocSeed;
    overrides?: Partial<SDKContextValue>;
}

/** Build a mock `SDKContextValue` for rendering module UI. */
export function createMockSdkContext(opts: MockSdkContextOptions = {}): SDKContextValue {
    const moduleId = opts.moduleId ?? 'mock';
    return {
        token: 'mock-token',
        currentUser: { id: 'u1', name: 'Tester', isGM: false, role: 1 },
        system: { id: moduleId, title: 'Mock System', version: '1.0.0' },
        isConnected: true,
        moduleId,
        worldId: opts.worldId ?? 'world-1',
        documents: createMockDocumentSource(opts.documents),
        baseUrl: 'http://localhost',
        foundryUrl: opts.foundryUrl ?? 'http://localhost:30000',
        resolveImageUrl: (p) => p,
        assetUrl: (p) => buildModuleAssetUrl(moduleId, p),
        navigate: () => {},
        replace: () => {},
        addNotification: () => {},
        isDiceTrayOpen: false,
        toggleDiceTray: () => {},
        isChatOpen: false,
        setChatOpen: () => {},
        fetchWithAuth: async () => new Response('{}', { status: 200 }),
        events: createMockSdkEvents(),
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        ...opts.overrides,
    };
}

const passthrough: ComponentType<{ children?: ReactNode }> = ({ children }) => createElement('div', null, children ?? null);

/** Stub platform components so module UI that reads `useSDKComponents()` can render. */
export function createMockSdkComponents(): SDKComponentsValue {
    return {
        LoadingModal: () => createElement('div', { 'data-mock': 'LoadingModal' }),
        RollDialog: passthrough,
        ConfirmationModal: passthrough,
        RichTextEditor: passthrough,
        SharedContentModal: () => null,
    };
}

/** Wrap a fixture component tree in the mock SDK context + components. */
export function MockSDKProvider(props: {
    children?: ReactNode;
    context?: SDKContextValue;
    components?: SDKComponentsValue;
}): ReactNode {
    const context = props.context ?? createMockSdkContext();
    const components = props.components ?? createMockSdkComponents();
    return createElement(
        SDKContext.Provider,
        { value: context },
        createElement(SDKComponentsContext.Provider, { value: components }, props.children ?? null),
    );
}
