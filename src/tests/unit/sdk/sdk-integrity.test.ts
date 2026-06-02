import { strict as assert } from 'node:assert';
import {
    BaseSystemAdapter,
    type SystemAdapter,
    type ActorSheetData,
    type ModuleServerRequest,
    type ModuleRequestRuntime,
    type ModuleServerParams,
    type ModuleServerExport,
    type ModuleRuntime,
    type DataStore,
    type CompendiumPackReader,
    type ModuleLogger,
    type UIModuleManifest,
    type FoundryActor,
    type FoundryItem,
    type LoadingModalProps,
    type RollDialogProps,
    type ConfirmationModalProps,
    type UseFoundry,
    type UseUI,
    type UseNotifications,
    type ActorSheetProps,
    type ActorPageProps,
    useDocument,
    useDocumentMutation,
    useActorSheet,
    createActorPage,
    json,
    error,
    SDK_VERSION,
    API_CONTRACT_VERSIONS,
} from '../../../shared/sdk/index';

// ---------------------------------------------------------------------------
// BaseSystemAdapter defaults
// ---------------------------------------------------------------------------

class MockAdapter extends BaseSystemAdapter {
    systemId = 'mock';

    override normalizeActorData(actor: FoundryActor): ActorSheetData {
        const data = super.normalizeActorData(actor);
        return { ...data, derived: { test: 'value' } };
    }
}

async function runAdapterTests() {
    const adapter = new MockAdapter();

    // identity
    assert.equal(adapter.systemId, 'mock');

    // normalizeActorData override
    const rawActor = { _id: '123', name: 'Test Actor', type: 'character', system: {}, img: null, items: [] } as FoundryActor;
    const normalized = adapter.normalizeActorData(rawActor);
    assert.equal(normalized.id, '123');
    assert.equal(normalized.name, 'Test Actor');
    assert.deepEqual(normalized.derived, { test: 'value' });

    // match — always false from BaseSystemAdapter
    assert.equal(adapter.match({ type: 'anything' } as any), false);

    // getInitiativeFormula default
    assert.equal(adapter.getInitiativeFormula!(rawActor), '1d20');

    // validateUpdate default
    assert.equal(adapter.validateUpdate!('system.hp', 10), true);

    // getRollData default
    assert.equal(adapter.getRollData!(rawActor, 'stat', 'str'), null);

    // getCompendiumPackConfig default
    const packs = adapter.getCompendiumPackConfig!();
    assert.ok(Array.isArray(packs.packs));
    assert.equal(packs.packs.length, 0);

    // getActorCardData default
    const card = adapter.getActorCardData!(rawActor);
    assert.equal(card.name, 'Test Actor');

    // computeActorData default
    const computed = adapter.computeActorData!(normalized);
    assert.ok(typeof computed === 'object');

    // initialize noop (no runtime, no throw)
    const mockRuntime: ModuleRuntime = {
        moduleId: 'mock',
        foundryUrl: 'http://localhost:30000',
        logger: {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
        },
        dataStore: {
            get: async () => null,
            set: async () => {},
            delete: async () => {},
            has: async () => false,
            keys: async () => [],
        },
        compendium: {
            findOne: async () => null,
            findAll: async () => [],
            getById: async () => null,
        },
        documents: {
            get: async () => null,
            list: async () => ({ rows: [], total: 0 }),
            fetchByUuid: async () => null,
        },
    };
    await adapter.initialize!(mockRuntime);
    assert.equal((adapter as any)._runtime, mockRuntime);

    console.log('  - BaseSystemAdapter: all checks passed');
}

// ---------------------------------------------------------------------------
// SystemAdapter interface satisfaction
// ---------------------------------------------------------------------------

async function runInterfaceTests() {
    const adapter = new MockAdapter();
    const typed: SystemAdapter = adapter;
    assert.ok(typed.normalizeActorData);
    assert.ok(typed.match);
    console.log('  - SystemAdapter interface: satisfied');
}

// ---------------------------------------------------------------------------
// ModuleServerRequest shape
// ---------------------------------------------------------------------------

async function runServerRequestTests() {
    // Verify the request shape a handler receives. `req.runtime` is the only document
    // surface (ADR-0027 decision 8); `getAccessContext` is the access surface.
    const mockRuntime: ModuleRequestRuntime = {
        moduleId: 'mock',
        foundryUrl: 'http://localhost:30000',
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        dataStore: {
            get: async () => null,
            set: async () => {},
            delete: async () => {},
            has: async () => false,
            keys: async () => [],
        },
        compendium: {
            findOne: async () => null,
            findAll: async () => [],
            getById: async () => null,
        },
        documents: {
            get: async () => null,
            list: async () => ({ rows: [], total: 0 }),
            fetchByUuid: async () => null,
            create: async () => ({}),
            patch: async () => ({}),
            upsert: async () => ({}),
            delete: async () => {},
            commit: async () => [],
            effects: {
                create: async () => ({}),
                update: async () => ({}),
                delete: async () => {},
            },
        },
        rolls: {
            roll: async () => ({ formula: '1d20', total: 1 }),
        },
        tables: {
            draw: async () => ({ roll: 1, formula: '1d20', results: [], items: [], table: {} }),
        },
    };
    const mockRequest: ModuleServerRequest = {
        json: async <T>() => ({} as T),
        method: 'POST',
        url: '/api/modules/mock/test',
        headers: { 'content-type': 'application/json' },
        userSession: { userId: 'u1', username: 'Tester', isGM: false, role: 1 },
        getAccessContext: () => ({ userId: 'u1', role: 1, isGM: false, moduleId: 'mock' }),
        runtime: mockRuntime,
    };

    assert.equal(mockRequest.method, 'POST');
    assert.equal(mockRequest.getAccessContext?.().userId, 'u1');
    assert.equal(mockRequest.getAccessContext?.().moduleId, 'mock');
    assert.equal(mockRequest.userSession?.isGM, false);

    const params: ModuleServerParams = {
        params: Promise.resolve({ systemId: 'mock', route: ['test'] }),
    };
    const resolved = await params.params;
    assert.equal(resolved.systemId, 'mock');
    assert.deepEqual(resolved.route, ['test']);

    // Response helpers (ADR-0027 decision 24)
    const ok = json({ ok: true }, { status: 201 });
    assert.equal(ok.status, 201);
    assert.deepEqual(await ok.json(), { ok: true });
    const err = error('out_of_scope', 'nope');
    assert.equal(err.status, 403);
    assert.equal((await err.json() as { code: string }).code, 'out_of_scope');

    console.log('  - ModuleServerRequest/Params + json/error: shape verified');
}

// ---------------------------------------------------------------------------
// ModuleServerExport shape
// ---------------------------------------------------------------------------

async function runServerExportTests() {
    const export_: ModuleServerExport = {
        apiRoutes: {
            'actor/[id]': async (req, _params) => {
                const body = await req.json();
                return { status: 200, json: async () => body };
            },
        },
    };
    assert.ok(export_.apiRoutes?.['actor/[id]']);
    console.log('  - ModuleServerExport: shape verified');
}

// ---------------------------------------------------------------------------
// ModuleRuntime shape
// ---------------------------------------------------------------------------

async function runContextTests() {
    const dataStore: DataStore = {
        get: async <T>(_key: string) => null as T | null,
        set: async (_key: string, _value: unknown) => {},
        delete: async (_key: string) => {},
        has: async (_key: string) => false,
        keys: async (_prefix?: string) => [],
    };

    const compendium: CompendiumPackReader = {
        findOne: async (_type, _query) => null,
        findAll: async (_type, _query) => [],
        getById: async (_type, _id) => null,
    };

    const logger: ModuleLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
    };

    const runtime: ModuleRuntime = {
        moduleId: 'test-module',
        foundryUrl: 'http://localhost:30000',
        logger,
        dataStore,
        compendium,
        documents: {
            get: async () => null,
            list: async () => ({ rows: [], total: 0 }),
            fetchByUuid: async () => null,
        },
    };

    assert.equal(runtime.moduleId, 'test-module');
    assert.ok(typeof runtime.logger.info === 'function');
    assert.ok(runtime.dataStore.get);
    assert.ok(runtime.dataStore.keys);
    assert.ok(runtime.compendium.findOne);

    console.log('  - ModuleRuntime: shape verified');
}

// ---------------------------------------------------------------------------
// UIModuleManifest shape
// ---------------------------------------------------------------------------

async function runManifestTests() {
    const manifest: UIModuleManifest = {
        info: {
            id: 'mock',
            title: 'Mock System',
            manifest: {
                ui: 'module/ui',
                logic: 'module/logic',
            },
        },
        sheet: () => Promise.resolve({ default: {} }),
        rollModal: () => Promise.resolve({ default: {} }),
        actorPage: () => Promise.resolve({ default: {} }),
        tools: {
            'generator': () => Promise.resolve({ default: {} }),
        },
        dashboardTools: () => Promise.resolve({ default: {} }),
    };

    assert.equal(manifest.info.id, 'mock');
    const sheet = await manifest.sheet();
    assert.ok(sheet.default !== undefined);
    console.log('  - UIModuleManifest: shape verified');
}

// ---------------------------------------------------------------------------
// UI prop interfaces — compile-time only (no runtime assertions needed)
// ---------------------------------------------------------------------------

function runUIPropTests() {
    // These just need to compile — verifies the types are exported correctly
    const _loadingProps: LoadingModalProps = { message: 'Loading...' };
    const _rollProps: RollDialogProps = { onRoll: () => {}, onClose: () => {} };
    const _confirmProps: ConfirmationModalProps = {
        title: 'Confirm',
        message: 'Are you sure?',
        onConfirm: () => {},
        onCancel: () => {},
    };
    const _sharedProps = { type: null, onClose: () => {} };

    const _useFoundry: UseFoundry = { token: null, currentUser: null, system: null, isConnected: false, baseUrl: '' };
    const _useUI: UseUI = { isDiceTrayOpen: false, toggleDiceTray: () => {}, isChatOpen: false, setChatOpen: () => {} };
    const _useNotifications: UseNotifications = { addNotification: () => {} };

    console.log('  - UI prop interfaces: compiled successfully');
}

// ---------------------------------------------------------------------------
// Client SDK — data hooks + actor sheet (decisions 16/17/25)
// ---------------------------------------------------------------------------

function runClientSdkTests() {
    // Sheet/page prop shapes compile and compose.
    const _sheetProps: ActorSheetProps = {
        actor: {} as FoundryActor,
        isOwner: true,
        onRoll: async () => {},
        onUpdate: async () => {},
    };
    const _pageProps: ActorPageProps = { actorId: 'a1' };
    void _sheetProps; void _pageProps;

    // Hooks are exported as functions (cannot be invoked outside a React render).
    assert.equal(typeof useDocument, 'function');
    assert.equal(typeof useDocumentMutation, 'function');
    assert.equal(typeof useActorSheet, 'function');

    // createActorPage produces a component without rendering it.
    const Page = createActorPage(() => null);
    assert.equal(typeof Page, 'function');

    console.log('  - Client SDK (hooks + actor sheet): surface verified');
}

// ---------------------------------------------------------------------------
// Version constants
// ---------------------------------------------------------------------------

function runVersionTests() {
    assert.equal(typeof SDK_VERSION, 'string');
    assert.ok(SDK_VERSION.length > 0);
    assert.ok('module-api' in API_CONTRACT_VERSIONS);
    assert.ok('ui-extension-api' in API_CONTRACT_VERSIONS);
    assert.ok('roll-engine-api' in API_CONTRACT_VERSIONS);
    console.log(`  - SDK version: ${SDK_VERSION}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function run() {
    console.log('SDK Integrity:');
    await runAdapterTests();
    await runInterfaceTests();
    await runServerRequestTests();
    await runServerExportTests();
    await runContextTests();
    await runManifestTests();
    runUIPropTests();
    runClientSdkTests();
    runVersionTests();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().then(() => {
        console.log('sdk-integrity.test.ts passed');
    }).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
