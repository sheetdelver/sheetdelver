import { strict as assert } from 'node:assert';
import { SessionManager } from '@core/session/SessionManager';
import { persistentCache } from '@core/cache/PersistentCache';
import { ClientSocket } from '@core/foundry/sockets/ClientSocket';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { worldLifecycleStore } from '@server/core/world/WorldLifecycleStore';

const CACHE_NS = 'core';
const CACHE_KEY = 'sessions';
const SESSION_TOKEN = 'session-token';
const WORLD_ID = 'world-1';

type ConnectWithRestoredCredential = ClientSocket['connectWithRestoredCredential'];

function createManager(): SessionManager {
    const manager = new SessionManager({ url: 'http://foundry.test' });
    (manager as any).waitForRestoreBackoff = async () => undefined;
    return manager;
}

function seedActiveWorld(worldId = WORLD_ID): void {
    worldStateStore.seed({
        world: { id: worldId, title: 'Test World' },
        system: { id: 'dnd5e', title: 'D&D 5e' },
        users: [],
    } as any);
    worldLifecycleStore.setState('active', 'session-manager-test');
}

async function writeCachedSession(worldId = WORLD_ID, overrides: Record<string, unknown> = {}): Promise<void> {
    await persistentCache.set(CACHE_NS, CACHE_KEY, {
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
    await persistentCache.delete(CACHE_NS, CACHE_KEY);
    worldStateStore.clear('session-manager-test');
    worldLifecycleStore.reset('session-manager-test');
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
        const session = await manager.getOrRestoreSession(SESSION_TOKEN);

        assert.equal(session, undefined);
        assert.equal(connectCalls, 0);

        const cached = await persistentCache.get<Record<string, unknown>>(CACHE_NS, CACHE_KEY);
        assert.equal(cached?.[SESSION_TOKEN], undefined, 'mismatched cached session should be purged');
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
        const session = await manager.getOrRestoreSession(SESSION_TOKEN);

        assert.equal(session, undefined);
        assert.equal(connectCalls, 0);

        const cached = await persistentCache.get<Record<string, unknown>>(CACHE_NS, CACHE_KEY);
        assert.equal(cached?.[SESSION_TOKEN], undefined, 'expired cached session should be purged');
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
        const session = await manager.getOrRestoreSession(SESSION_TOKEN);

        assert.equal(session, undefined);
        assert.equal(connectCalls, 0);

        const cached = await persistentCache.get<Record<string, unknown>>(CACHE_NS, CACHE_KEY);
        assert.equal(cached?.[SESSION_TOKEN], undefined, 'cached session without a world id should be purged once the active world is known');
    });

    await resetState();
}

async function runStartupRestoreDefersUntilWorldIdExists() {
    await resetState();
    worldLifecycleStore.setState('startup', 'session-manager-test');
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

        const cached = await persistentCache.get<Record<string, unknown>>(CACHE_NS, CACHE_KEY);
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
    worldLifecycleStore.setState('startup', 'session-manager-test');
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
        const cached = await persistentCache.get<Record<string, unknown>>(CACHE_NS, CACHE_KEY);
        assert.ok(cached?.[SESSION_TOKEN], 'startup defer must not purge cache entries');

        // In-memory sessions still flow through: seed one, request it, and
        // verify the manager returns it without consulting cache or transport.
        const fakeClient = {} as ClientSocket;
        (manager as any).sessions.set(SESSION_TOKEN, {
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

export async function run() {
    await runConcurrentRestoreDedupesTransport();
    await runWorldMismatchPurgesWithoutTransportConnect();
    await runExpiredCachedSessionPurgesWithoutTransportConnect();
    await runCachedSessionWithoutWorldIdPurgesWhenWorldIsKnown();
    await runStartupRestoreDefersUntilWorldIdExists();
    await runStartupReturnsUndefinedWithoutSpawningClient();
    await runFailedRestoreDisconnectsAndClearsInFlight();
    console.log('  - SessionManager restore: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('session-manager-restore.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
