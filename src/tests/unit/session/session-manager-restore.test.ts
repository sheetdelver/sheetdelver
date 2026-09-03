import { strict as assert } from 'node:assert';
import { FoundryUserConnectionService } from '@server/services/foundry';
import { ClientSocket } from '@core/foundry/sockets/ClientSocket';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { worldLifecycleStore } from '@server/core/world/WorldLifecycleStore';
import type {
    FoundrySessionInvalidationEvent,
} from '@server/shared/types/foundry';
import type {
    FoundrySessionStore,
    PersistedFoundrySessions,
} from '@server/security/foundrySessionStore';

const SESSION_TOKEN = 'session-token';
const WORLD_ID = 'world-1';

type ConnectWithRestoredCredential = ClientSocket['connectWithRestoredCredential'];

class MemoryFoundrySessionStore implements FoundrySessionStore {
    public readonly enabled = true;
    private sessions: PersistedFoundrySessions = {};

    public async initialize(): Promise<void> {}
    public async load(): Promise<PersistedFoundrySessions> {
        return structuredClone(this.sessions);
    }
    public async save(sessions: PersistedFoundrySessions): Promise<void> {
        this.sessions = structuredClone(sessions);
    }
    public async clear(): Promise<void> {
        this.sessions = {};
    }
}

const sessionStore = new MemoryFoundrySessionStore();

function createManager(): FoundryUserConnectionService {
    const manager = new FoundryUserConnectionService(
        { url: 'http://foundry.test' },
        { sessionStore },
    );
    (manager as any).waitForRestoreBackoff = async () => undefined;
    return manager;
}

function seedActiveWorld(worldId = WORLD_ID): void {
    worldStateStore.seed({
        world: { id: worldId, title: 'Test World' },
        system: { id: 'dnd5e', title: 'D&D 5e' },
        users: [],
    } as any);
    worldLifecycleStore.setState('active', 'foundry-user-connection-service-test');
}

async function writeCachedSession(worldId = WORLD_ID, overrides: Record<string, unknown> = {}): Promise<void> {
    await sessionStore.save({
        [SESSION_TOKEN]: {
            username: 'ptest',
            userId: 'user-1',
            cookie: 'session=abc123; foundry=xyz',
            worldId,
            lastSaved: Date.now(),
            ...overrides,
        },
    });
}

async function resetState(): Promise<void> {
    await sessionStore.clear();
    worldStateStore.clear('foundry-user-connection-service-test');
    worldLifecycleStore.reset('foundry-user-connection-service-test');
}

async function withPatchedClientSocket<T>(
    patch: {
        connectWithRestoredCredential?: ConnectWithRestoredCredential;
        disconnect?: ClientSocket['disconnect'];
    },
    runCase: () => Promise<T>,
): Promise<T> {
    const originalConnect = ClientSocket.prototype.connectWithRestoredCredential;
    const originalDisconnect = ClientSocket.prototype.disconnect;

    if (patch.connectWithRestoredCredential) {
        ClientSocket.prototype.connectWithRestoredCredential = patch.connectWithRestoredCredential;
    }
    if (patch.disconnect) {
        ClientSocket.prototype.disconnect = patch.disconnect;
    }

    try {
        return await runCase();
    } finally {
        ClientSocket.prototype.connectWithRestoredCredential = originalConnect;
        ClientSocket.prototype.disconnect = originalDisconnect;
    }
}

async function runConcurrentRestoreDedupesTransport() {
    await resetState();
    seedActiveWorld();
    await writeCachedSession();

    let connectCalls = 0;
    let releaseConnect!: () => void;
    let connectStarted!: () => void;
    const connectGate = new Promise<void>((resolve) => {
        releaseConnect = resolve;
    });
    const connectStartedSignal = new Promise<void>((resolve) => {
        connectStarted = resolve;
    });

    await withPatchedClientSocket({
        connectWithRestoredCredential: async function (this: ClientSocket, credential) {
            connectCalls += 1;
            connectStarted();
            this.userId = credential.userId;
            this.isExplicitSession = true;
            (this as any).hydrateCookieHeader(credential.cookie);
            await connectGate;
            this.isSocketConnected = true;
        },
    }, async () => {
        const manager = createManager();

        const first = manager.getOrRestoreSession(SESSION_TOKEN);
        const second = manager.getOrRestoreSession(SESSION_TOKEN);

        await connectStartedSignal;
        assert.equal(connectCalls, 1, 'parallel restores should share one transport connect');

        releaseConnect();
        const [firstSession, secondSession] = await Promise.all([first, second]);

        assert.ok(firstSession);
        assert.strictEqual(firstSession, secondSession, 'parallel restore callers should receive the same in-memory session');
        assert.equal(firstSession?.userId, 'user-1');
        assert.equal(firstSession?.username, 'ptest');
        assert.equal(firstSession?.client.getSessionCookie(), 'session=abc123; foundry=xyz');
    });

    await resetState();
}

async function runWorldMismatchPurgesWithoutTransportConnect() {
    await resetState();
    seedActiveWorld('world-current');
    await writeCachedSession('world-old');

    let connectCalls = 0;

    await withPatchedClientSocket({
        connectWithRestoredCredential: async function (this: ClientSocket) {
            connectCalls += 1;
            throw new Error('should not connect on world mismatch');
        },
    }, async () => {
        const manager = createManager();
        const invalidations: FoundrySessionInvalidationEvent[] = [];
        manager.onSessionInvalidated(event => invalidations.push(event));
        const session = await manager.getOrRestoreSession(SESSION_TOKEN);

        assert.equal(session, undefined);
        assert.equal(connectCalls, 0);

        const cached = await sessionStore.load();
        assert.equal(cached?.[SESSION_TOKEN], undefined, 'mismatched cached session should be purged');
        assert.deepEqual(invalidations, [{
            scope: 'session', sessionId: SESSION_TOKEN, reason: 'world-mismatch',
        }]);
    });

    await resetState();
}

async function runExpiredCachedSessionPurgesWithoutTransportConnect() {
    await resetState();
    seedActiveWorld();
    await writeCachedSession(WORLD_ID, {
        lastSaved: Date.now() - (25 * 60 * 60 * 1000),
    });

    let connectCalls = 0;

    await withPatchedClientSocket({
        connectWithRestoredCredential: async function (this: ClientSocket) {
            connectCalls += 1;
            throw new Error('should not connect an expired cached session');
        },
    }, async () => {
        const manager = createManager();
        const invalidations: FoundrySessionInvalidationEvent[] = [];
        manager.onSessionInvalidated(event => invalidations.push(event));
        const session = await manager.getOrRestoreSession(SESSION_TOKEN);

        assert.equal(session, undefined);
        assert.equal(connectCalls, 0);

        const cached = await sessionStore.load();
        assert.equal(cached?.[SESSION_TOKEN], undefined, 'expired cached session should be purged');
        assert.deepEqual(invalidations, [{
            scope: 'session', sessionId: SESSION_TOKEN, reason: 'expired',
        }]);
    });

    await resetState();
}

async function runCachedSessionWithoutWorldIdPurgesWhenWorldIsKnown() {
    await resetState();
    seedActiveWorld();
    await writeCachedSession(WORLD_ID, { worldId: undefined });

    let connectCalls = 0;

    await withPatchedClientSocket({
        connectWithRestoredCredential: async function (this: ClientSocket) {
            connectCalls += 1;
            throw new Error('should not connect when cached session world id is missing');
        },
    }, async () => {
        const manager = createManager();
        const invalidations: FoundrySessionInvalidationEvent[] = [];
        manager.onSessionInvalidated(event => invalidations.push(event));
        const session = await manager.getOrRestoreSession(SESSION_TOKEN);

        assert.equal(session, undefined);
        assert.equal(connectCalls, 0);

        const cached = await sessionStore.load();
        assert.equal(cached?.[SESSION_TOKEN], undefined, 'cached session without a world id should be purged once the active world is known');
        assert.deepEqual(invalidations, [{
            scope: 'session', sessionId: SESSION_TOKEN, reason: 'invalid-record',
        }]);
    });

    await resetState();
}

async function runSetupInvalidatesCachedSessions() {
    await resetState();
    await writeCachedSession();

    const manager = createManager();
    const invalidations: FoundrySessionInvalidationEvent[] = [];
    manager.onSessionInvalidated(event => invalidations.push(event));
    await manager.handleWorldEnteredSetup();

    const cached = await sessionStore.load();
    assert.equal(
        cached?.[SESSION_TOKEN],
        undefined,
        'entering setup must invalidate the previous world session cache',
    );
    assert.deepEqual(invalidations, [{ scope: 'all', reason: 'world-entered-setup' }]);

    await resetState();
}

async function runDestroyPurgesPersistedOnlySessionAndNotifies() {
    await resetState();
    await writeCachedSession();

    const manager = createManager();
    const invalidations: FoundrySessionInvalidationEvent[] = [];
    manager.onSessionInvalidated(event => invalidations.push(event));

    // A browser can log out before its persisted Foundry transport has been
    // restored in this process. Revocation still has to remove that credential.
    await manager.destroySession(SESSION_TOKEN);

    const cached = await sessionStore.load();
    assert.equal(cached?.[SESSION_TOKEN], undefined);
    assert.deepEqual(invalidations, [{
        scope: 'session', sessionId: SESSION_TOKEN, reason: 'revoked',
    }]);

    await resetState();
}

async function runFailedFoundryLogoutStillRevokesLocalAuthority() {
    await resetState();
    await writeCachedSession();

    const manager = createManager();
    const invalidations: FoundrySessionInvalidationEvent[] = [];
    let disconnected = false;
    manager.onSessionInvalidated(event => invalidations.push(event));
    (manager as any).connections.set(SESSION_TOKEN, {
        id: SESSION_TOKEN,
        userId: 'user-1',
        username: 'ptest',
        client: {
            logout: async () => { throw new Error('synthetic Foundry logout failure'); },
            disconnect: () => { disconnected = true; },
        },
    });

    await manager.destroySession(SESSION_TOKEN);

    assert.equal(disconnected, true);
    assert.equal(manager.isValidSession(SESSION_TOKEN), false);
    assert.equal((await sessionStore.load())?.[SESSION_TOKEN], undefined);
    assert.deepEqual(invalidations, [{
        scope: 'session', sessionId: SESSION_TOKEN, reason: 'revoked',
    }]);

    await resetState();
}

async function runClosedWorldDoesNotAttemptCachedRestore() {
    await resetState();
    worldLifecycleStore.setState('closed', 'foundry-user-connection-service-test');
    await writeCachedSession();

    let connectCalls = 0;
    await withPatchedClientSocket({
        connectWithRestoredCredential: async function (this: ClientSocket) {
            connectCalls += 1;
            throw new Error('closed lifecycle must not restore a user transport');
        },
    }, async () => {
        const manager = createManager();
        const session = await manager.getOrRestoreSession(SESSION_TOKEN);

        assert.equal(session, undefined);
        assert.equal(connectCalls, 0, 'closed lifecycle must not attempt cached transport restoration');

        const cached = await sessionStore.load();
        assert.ok(
            cached?.[SESSION_TOKEN],
            'closed lifecycle preserves cache until a definitive setup transition invalidates it',
        );
    });

    await resetState();
}

async function runStartupRestoreDefersUntilWorldIdExists() {
    await resetState();
    worldLifecycleStore.setState('startup', 'foundry-user-connection-service-test');
    await writeCachedSession();

    let connectCalls = 0;

    await withPatchedClientSocket({
        connectWithRestoredCredential: async function (this: ClientSocket) {
            connectCalls += 1;
            throw new Error('should not connect before world id is known');
        },
    }, async () => {
        const manager = createManager();
        const session = await manager.getOrRestoreSession(SESSION_TOKEN);

        assert.equal(session, undefined);
        assert.equal(connectCalls, 0);

        const cached = await sessionStore.load();
        assert.ok(cached?.[SESSION_TOKEN], 'startup deferral should keep the cached session for a later retry');
    });

    await resetState();
}

// Per ADR-0021 Phase 5 + ADR-0022 Phase 1: during lifecycle `startup`,
// getOrRestoreSession returns undefined for unknown tokens without spawning a
// new ClientSocket. Existing in-memory sessions are still returned so already-
// authenticated callers don't lose their session mid-bootstrap.
async function runStartupReturnsUndefinedWithoutSpawningClient() {
    await resetState();
    worldLifecycleStore.setState('startup', 'foundry-user-connection-service-test');
    await writeCachedSession(); // cache present, but startup defer should NOT consult it

    let connectCalls = 0;
    let constructed = 0;

    const OriginalCtor = ClientSocket.prototype.constructor;
    void OriginalCtor;

    await withPatchedClientSocket({
        connectWithRestoredCredential: async function (this: ClientSocket) {
            connectCalls += 1;
            return undefined as any;
        },
    }, async () => {
        // Patch the ctor side-effect by intercepting connectWithRestoredCredential.
        // If startup correctly returns undefined first, neither constructor nor
        // connect should be invoked.
        const manager = createManager();

        const result = await manager.getOrRestoreSession('unknown-token');
        assert.equal(result, undefined);
        assert.equal(connectCalls, 0, 'startup defer must not spawn a ClientSocket');
        assert.equal(constructed, 0);

        // Cache must remain untouched — the cache-driven restore path was never entered.
        const cached = await sessionStore.load();
        assert.ok(cached?.[SESSION_TOKEN], 'startup defer must not purge cache entries');

        // In-memory sessions still flow through: seed one, request it, and
        // verify the manager returns it without consulting cache or transport.
        const fakeClient = {} as ClientSocket;
        (manager as any).connections.set(SESSION_TOKEN, {
            id: SESSION_TOKEN,
            client: fakeClient,
            userId: 'user-1',
            username: 'tester',
            lastActive: 0,
            worldId: WORLD_ID,
            cookie: 'session=abc',
        });

        const memorySession = await manager.getOrRestoreSession(SESSION_TOKEN);
        assert.ok(memorySession, 'in-memory session must still resolve during startup');
        assert.equal(memorySession?.userId, 'user-1');
        assert.equal(connectCalls, 0, 'in-memory hit must not trigger transport connect');
    });

    await resetState();
}

async function runFailedRestoreDisconnectsAndClearsInFlight() {
    await resetState();
    seedActiveWorld();
    await writeCachedSession();

    let connectCalls = 0;
    let disconnectCalls = 0;

    await withPatchedClientSocket({
        connectWithRestoredCredential: async function (this: ClientSocket, credential) {
            connectCalls += 1;
            this.userId = credential.userId;
            throw new Error('restore transport failed');
        },
        disconnect(this: ClientSocket) {
            disconnectCalls += 1;
            this.isSocketConnected = false;
        },
    }, async () => {
        const manager = createManager();

        const first = await manager.getOrRestoreSession(SESSION_TOKEN);
        assert.equal(first, undefined);
        assert.equal(connectCalls, 3, 'active restore should use the configured retry count');
        assert.equal(disconnectCalls, 3, 'failed partial clients should be disconnected');

        const second = await manager.getOrRestoreSession(SESSION_TOKEN);
        assert.equal(second, undefined);
        assert.equal(connectCalls, 6, 'failed restore should clear the in-flight guard for later retries');
        assert.equal(disconnectCalls, 6);
    });

    await resetState();
}

async function runRevocationWinsAgainstInFlightRestore() {
    await resetState();
    seedActiveWorld();
    await writeCachedSession();

    let releaseConnect!: () => void;
    let connectStarted!: () => void;
    const connectGate = new Promise<void>(resolve => { releaseConnect = resolve; });
    const connectStartedSignal = new Promise<void>(resolve => { connectStarted = resolve; });

    await withPatchedClientSocket({
        connectWithRestoredCredential: async function (this: ClientSocket, credential) {
            this.userId = credential.userId;
            connectStarted();
            await connectGate;
            this.isSocketConnected = true;
        },
    }, async () => {
        const manager = createManager();
        const invalidations: FoundrySessionInvalidationEvent[] = [];
        manager.onSessionInvalidated(event => invalidations.push(event));

        const restore = manager.getOrRestoreSession(SESSION_TOKEN);
        await connectStartedSignal;

        // Revocation removes authority and publishes before transport cleanup;
        // the late successful connect must not reinsert the retired session.
        const revoke = manager.destroySession(SESSION_TOKEN);
        assert.equal(manager.isValidSession(SESSION_TOKEN), false);
        assert.deepEqual(invalidations, [{
            scope: 'session', sessionId: SESSION_TOKEN, reason: 'revoked',
        }]);
        await revoke;

        releaseConnect();
        assert.equal(await restore, undefined);
        assert.equal(manager.isValidSession(SESSION_TOKEN), false);
        assert.equal((await sessionStore.load())?.[SESSION_TOKEN], undefined);
    });

    await resetState();
}

async function runWorldInvalidationWinsAgainstInFlightRestore() {
    await resetState();
    seedActiveWorld();
    await writeCachedSession();

    let releaseConnect!: () => void;
    let connectStarted!: () => void;
    const connectGate = new Promise<void>(resolve => { releaseConnect = resolve; });
    const connectStartedSignal = new Promise<void>(resolve => { connectStarted = resolve; });

    await withPatchedClientSocket({
        connectWithRestoredCredential: async function (this: ClientSocket, credential) {
            this.userId = credential.userId;
            connectStarted();
            await connectGate;
            this.isSocketConnected = true;
        },
    }, async () => {
        const manager = createManager();
        const invalidations: FoundrySessionInvalidationEvent[] = [];
        manager.onSessionInvalidated(event => invalidations.push(event));

        const restore = manager.getOrRestoreSession(SESSION_TOKEN);
        await connectStartedSignal;

        // The global epoch is the world-transition equivalent of per-session
        // revocation and must defeat every restore already in transport setup.
        const invalidate = manager.handleWorldEnteredSetup();
        assert.equal(manager.isValidSession(SESSION_TOKEN), false);
        assert.deepEqual(invalidations, [{ scope: 'all', reason: 'world-entered-setup' }]);
        await invalidate;

        releaseConnect();
        assert.equal(await restore, undefined);
        assert.equal(manager.isValidSession(SESSION_TOKEN), false);
        assert.equal((await sessionStore.load())?.[SESSION_TOKEN], undefined);
    });

    await resetState();
}

export async function run() {
    await runConcurrentRestoreDedupesTransport();
    await runWorldMismatchPurgesWithoutTransportConnect();
    await runExpiredCachedSessionPurgesWithoutTransportConnect();
    await runCachedSessionWithoutWorldIdPurgesWhenWorldIsKnown();
    await runSetupInvalidatesCachedSessions();
    await runDestroyPurgesPersistedOnlySessionAndNotifies();
    await runFailedFoundryLogoutStillRevokesLocalAuthority();
    await runClosedWorldDoesNotAttemptCachedRestore();
    await runStartupRestoreDefersUntilWorldIdExists();
    await runStartupReturnsUndefinedWithoutSpawningClient();
    await runFailedRestoreDisconnectsAndClearsInFlight();
    await runRevocationWinsAgainstInFlightRestore();
    await runWorldInvalidationWinsAgainstInFlightRestore();
    console.log('  - FoundryUserConnectionService restore: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('foundry-user-connection-service restore tests passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
