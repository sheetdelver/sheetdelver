import { strict as assert } from 'node:assert';
import {
    BaseSystemAdapter,
    type SystemAdapter,
    type ActorSheetData,
    type ModuleFoundryClient,
    type ModuleServerRequest,
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
    SDK_VERSION,
    API_CONTRACT_VERSIONS,
} from '../../../shared/sdk/index';

// ---------------------------------------------------------------------------
// BaseSystemAdapter defaults
// ---------------------------------------------------------------------------

class MockAdapter extends BaseSystemAdapter {
    systemId = 'mock';

    override normalizeActorData(actor: FoundryActor, _client?: ModuleFoundryClient): ActorSheetData {
        const data = super.normalizeActorData(actor, _client);
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
    // Verify the shape is what a handler would receive
    const mockRequest: ModuleServerRequest = {
        json: async <T>() => ({} as T),
        method: 'POST',
        url: '/api/modules/mock/test',
        headers: { 'content-type': 'application/json' },
        foundryClient: {
            isConnected: true,
            roll: async () => ({ id: '1', content: '', timestamp: 0, user: '' }),
            sendMessage: async () => ({ id: '1', content: '', timestamp: 0, user: '' }),
            useItem: async () => null,
            getActor: async () => ({}),
            getActors: async () => [],
            createActor: async () => ({}),
            updateActor: async () => ({}),
            deleteActor: async () => {},
            createActorItem: async () => ({}),
            updateActorItem: async () => ({}),
            deleteActorItem: async () => {},
            createActorEffect: async () => ({}),
            updateActorEffect: async () => ({}),
            deleteActorEffect: async () => {},
            createItemEffect: async () => ({}),
            updateItemEffect: async () => ({}),
            deleteItemEffect: async () => {},
            fetchByUuid: async () => ({}),
            getWorldItems: async () => [],
            drawTable: async () => ({ roll: 1, formula: '1d20', results: [], items: [], table: {} }),
            resolveUrl: (p) => p,
            getSystemId: async () => 'mock',
        },
        userSession: { userId: 'u1', username: 'Tester', isGM: false, role: 1 },
    };

    assert.equal(mockRequest.method, 'POST');
    assert.ok(mockRequest.foundryClient.isConnected);
    assert.equal(mockRequest.userSession?.isGM, false);

    const params: ModuleServerParams = {
        params: Promise.resolve({ systemId: 'mock', route: ['test'] }),
    };
    const resolved = await params.params;
    assert.equal(resolved.systemId, 'mock');
    assert.deepEqual(resolved.route, ['test']);

    console.log('  - ModuleServerRequest/Params: shape verified');
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
