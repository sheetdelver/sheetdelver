import { strict as assert } from 'node:assert';
import { registerAppSocketGateway } from '@server/realtime/AppSocketGateway';
import { systemService } from '@server/services/world';
import { engagementService } from '@server/services/world';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { FoundryUserRole } from '@server/core/documents/primary/base/ownership';
import type { SystemStatusPayload } from '@shared/contracts/status';
import { PLAYER_SESSION_COOKIE_NAME } from '@server/security/playerSessionCookie';
import type {
    FoundrySessionInvalidationEvent,
    FoundrySessionInvalidationListener,
} from '@server/shared/types/foundry';

type EventHandler = (...args: unknown[]) => void;

interface MockSocket {
    id: string;
    connected: boolean;
    handshake: { headers: { cookie?: string } };
    rooms: Set<string>;
    join: (room: string) => void;
    leave: (room: string) => void;
    emit: (event: string, payload?: unknown) => void;
    on: (event: string, handler: EventHandler) => void;
    off: (event: string, handler: EventHandler) => void;
    userSession?: unknown;
    foundryClient?: MockFoundryClient;
}

interface MockFoundryClient {
    userId?: string | null;
    isConnected: boolean;
    url: string;
    on: (event: string, handler: EventHandler) => void;
    off: (event: string, handler: EventHandler) => void;
    dispatchDocument: () => Promise<unknown>;
    dispatchDocumentSocket: () => Promise<unknown>;
}

async function runGatewayTests() {
    let authMiddleware: ((socket: MockSocket, next: () => void) => Promise<void>) | undefined;
    let connectionHandler: ((socket: MockSocket) => Promise<void>) | undefined;

    const io = {
        engine: { clientsCount: 1 },
        use: (middleware: (socket: MockSocket, next: () => void) => Promise<void>) => {
            authMiddleware = middleware;
        },
        on: (event: string, handler: (socket: MockSocket) => Promise<void>) => {
            if (event === 'connection') connectionHandler = handler;
        },
    };

    const attachedHandlers: Array<{ event: string; handler: EventHandler }> = [];
    const detachedHandlers: Array<{ event: string; handler: EventHandler }> = [];
    const systemAttachedHandlers: Array<{ event: string; handler: EventHandler }> = [];
    const systemDetachedHandlers: Array<{ event: string; handler: EventHandler }> = [];
    const invalidationListeners = new Set<FoundrySessionInvalidationListener>();
    let validSession = true;

    const foundryClient: MockFoundryClient = {
        userId: 'user-1',
        isConnected: true,
        url: 'http://foundry.test',
        on: (event, handler) => attachedHandlers.push({ event, handler }),
        off: (event, handler) => detachedHandlers.push({ event, handler }),
        dispatchDocument: async () => ({}),
        dispatchDocumentSocket: async () => ({}),
    };

    const foundryUserConnections = {
        isCacheReady: () => true,
        isValidSession: (token: string) => token === 'valid-token' && validSession,
        getOrRestoreSession: async (token: string) => {
            if (token === 'valid-token') {
                return { client: foundryClient, userId: 'user-1', username: 'tester' };
            }
            return undefined;
        },
        onSessionInvalidated: (listener: FoundrySessionInvalidationListener) => {
            invalidationListeners.add(listener);
            return () => invalidationListeners.delete(listener);
        },
    };

    const originalGetSystemClient = (systemService as any).getSystemClient;
    const originalIsReady = (systemService as any).isReady;
    const originalSetActiveBrowserCount = engagementService.setActiveBrowserCount;
    const browserCounts: number[] = [];
    let worldReady = true;

    try {
        await userStore.seed(async () => [
            { _id: 'user-1', name: 'Gateway User', role: FoundryUserRole.GAMEMASTER },
        ]);

        (systemService as any).getSystemClient = () => ({
            on: (event: string, handler: EventHandler) => systemAttachedHandlers.push({ event, handler }),
            off: (event: string, handler: EventHandler) => systemDetachedHandlers.push({ event, handler }),
        });
        (systemService as any).isReady = () => worldReady;
        engagementService.setActiveBrowserCount = ((count: number) => {
            browserCounts.push(count);
            return { previousCount: 0, browserCount: count, becameEngaged: count > 0 };
        }) as typeof engagementService.setActiveBrowserCount;

        const emitted: Array<{ event: string; payload: unknown }> = [];
        const socketHandlers = new Map<string, EventHandler[]>();

        const socket: MockSocket = {
            id: 'socket-1',
            connected: true,
            handshake: { headers: { cookie: `${PLAYER_SESSION_COOKIE_NAME}=valid-token` } },
            rooms: new Set(),
            join(room: string) {
                this.rooms.add(room);
            },
            leave(room: string) {
                this.rooms.delete(room);
            },
            emit(event: string, payload?: unknown) {
                emitted.push({ event, payload });
            },
            on(event: string, handler: EventHandler) {
                socketHandlers.set(event, [...(socketHandlers.get(event) ?? []), handler]);
            },
            off(event: string, handler: EventHandler) {
                socketHandlers.set(
                    event,
                    (socketHandlers.get(event) ?? []).filter(candidate => candidate !== handler),
                );
            },
        };

        registerAppSocketGateway({
            io: io as any,
            foundryUserConnections: foundryUserConnections as any,
            getSystemStatusPayload: async () => ({
                connected: true,
                worldId: 'w1',
                initialized: true,
                isConfigured: true,
                foundryCompatibility: null,
                users: [],
                system: { id: 'shadowdark', worldTitle: 'Test', status: 'active' },
                url: 'http://localhost:30000',
                appVersion: '0.0.0-test',
                debug: { enabled: false, level: 1 },
            } as SystemStatusPayload),
            getPublicStatusPayload: async () => ({
                connected: true,
                initialized: true,
                isConfigured: true,
                foundryCompatibility: null,
                users: [{ name: 'Gateway User', active: false, canLogin: true }],
                system: {
                    id: 'shadowdark',
                    worldTitle: 'Test',
                    worldDescription: '<p>Campaign introduction</p>',
                    worldBackground: 'http://foundry.test/world.webp',
                    nextSession: 'Saturday at 7 PM',
                    status: 'active',
                },
                appVersion: '0.0.0-test',
            }),
            broadcastSystemStatus: () => undefined,
        });

        assert.ok(authMiddleware);
        assert.ok(connectionHandler);

        let nextCalled = false;
        await authMiddleware!(socket, () => {
            nextCalled = true;
        });

        assert.equal(nextCalled, true);
        assert.equal(socket.rooms.has('authenticated'), true);
        assert.ok(socket.userSession);
        assert.ok(socket.foundryClient);

        await connectionHandler!(socket);

        assert.ok(emitted.some((entry) => entry.event === 'systemStatus'));
        // Per-user Foundry clients are route transports only here. World lifecycle,
        // shared-content, presence/status, and combat updates flow through the
        // system client / Store bridges.
        // The system client carries Store-bridged events:
        //   actorChanged + actorListInvalidated
        //   + chatMessageChanged + chatMessageListInvalidated
        //   + userChanged + userListInvalidated + folderChanged + folderListInvalidated
        //   + journalChanged + journalListInvalidated
        //   + combatChanged + combatListInvalidated
        //   + itemChanged + itemListInvalidated
        //   + rollTableChanged + rollTableListInvalidated
        //   + macroChanged + macroListInvalidated
        //   + playlistChanged + playlistListInvalidated
        //   + cardsChanged + cardsListInvalidated
        //   + sceneChanged + sceneListInvalidated
        //   + settingChanged + settingListInvalidated = 26.
        assert.equal(attachedHandlers.length, 0);
        assert.equal(systemAttachedHandlers.length, 26);
        assert.ok(systemAttachedHandlers.some((entry) => entry.event === 'actorListInvalidated'));
        assert.ok(systemAttachedHandlers.some((entry) => entry.event === 'sceneListInvalidated'));
        assert.ok(systemAttachedHandlers.some((entry) => entry.event === 'settingListInvalidated'));
        assert.ok(browserCounts.includes(1));

        const userChanged = systemAttachedHandlers.find((entry) => entry.event === 'userChanged')?.handler;
        assert.ok(userChanged);

        worldReady = false;
        userChanged!({ userId: 'user-1', action: 'update', audience: { kind: 'all' } });
        assert.equal(emitted.some((entry) => entry.event === 'userChanged'), false);

        worldReady = true;
        userChanged!({ userId: 'user-1', action: 'update', audience: { kind: 'all' } });
        assert.equal(emitted.some((entry) => entry.event === 'userChanged'), true);
        const browserUserChange = emitted.find((entry) => entry.event === 'userChanged')?.payload as Record<string, unknown>;
        assert.equal(
            Object.hasOwn(browserUserChange, 'audience'),
            false,
            'internal recipient identities are removed from browser payloads',
        );

        // The authenticated fixture is a GM, so the Setting type-level policy
        // permits its invalidation hint without exposing the document body.
        const settingChanged = systemAttachedHandlers.find((entry) => entry.event === 'settingChanged')?.handler;
        assert.ok(settingChanged);
        settingChanged!({
            settingId: 'setting-1',
            action: 'update',
            audience: { kind: 'users', userIds: ['user-1'] },
        });
        assert.equal(
            emitted.some((entry) => entry.event === 'settingChanged'),
            true,
        );
        const settingListInvalidated = systemAttachedHandlers
            .find((entry) => entry.event === 'settingListInvalidated')?.handler;
        assert.ok(settingListInvalidated);
        settingListInvalidated!({
            reason: 'create',
            settingId: 'setting-2',
            audience: { kind: 'users', userIds: ['user-1'] },
        });
        assert.equal(
            emitted.some((entry) => entry.event === 'settingListInvalidated'),
            true,
        );

        // `none`, a nonmatching explicit user set, and malformed legacy
        // envelopes all fail closed instead of becoming authenticated broadcasts.
        const settingEventCount = emitted.filter((entry) => entry.event === 'settingChanged').length;
        settingChanged!({ settingId: 'none', action: 'update', audience: { kind: 'none' } });
        settingChanged!({
            settingId: 'someone-else',
            action: 'update',
            audience: { kind: 'users', userIds: ['user-2'] },
        });
        settingChanged!({ settingId: 'missing-audience', action: 'update' });
        assert.equal(
            emitted.filter((entry) => entry.event === 'settingChanged').length,
            settingEventCount,
        );

        // An unrelated session event leaves this socket authorized. Its own
        // invalidation immediately strips rooms, references, and listeners.
        for (const listener of invalidationListeners) {
            listener({ scope: 'session', sessionId: 'another-token', reason: 'revoked' });
        }
        assert.equal(socket.rooms.has('authenticated'), true);

        const worldEventCount = emitted.filter(entry => entry.event === 'userChanged').length;
        const statusCountBeforeInvalidation = emitted.filter(entry => entry.event === 'systemStatus').length;
        for (const listener of invalidationListeners) {
            listener({ scope: 'session', sessionId: 'valid-token', reason: 'expired' });
        }
        await Promise.resolve();
        await Promise.resolve();

        assert.equal(socket.rooms.has('authenticated'), false);
        assert.equal(socket.rooms.has('status:public'), true);
        assert.equal(socket.userSession, undefined);
        assert.equal(socket.foundryClient, undefined);
        const invalidated = emitted.find(entry => entry.event === 'sessionInvalidated')?.payload as Record<string, unknown>;
        assert.deepEqual(invalidated, { reason: 'expired' });
        assert.equal(JSON.stringify(invalidated).includes('valid-token'), false);
        assert.equal(systemDetachedHandlers.length, 26);
        assert.equal(
            emitted.filter(entry => entry.event === 'systemStatus').length,
            statusCountBeforeInvalidation,
            'retirement must not emit a pre-logout public roster snapshot',
        );

        // A callback already captured by an emitter must also fail closed after
        // authority retirement, even though normal listener detachment ran.
        userChanged!({ userId: 'user-1', action: 'update', audience: { kind: 'all' } });
        assert.equal(
            emitted.filter(entry => entry.event === 'userChanged').length,
            worldEventCount,
        );

        io.engine.clientsCount = 0;
        socket.connected = false;
        for (const handler of socketHandlers.get('disconnect') ?? []) handler();

        assert.equal(detachedHandlers.length, 0);
        assert.equal(systemDetachedHandlers.length, 26);
        assert.ok(systemDetachedHandlers.some((entry) => entry.event === 'actorListInvalidated'));
        assert.ok(systemDetachedHandlers.some((entry) => entry.event === 'sceneListInvalidated'));
        assert.ok(systemDetachedHandlers.some((entry) => entry.event === 'settingListInvalidated'));
        assert.ok(browserCounts.includes(0));

        // Guest degradation path (no cookie): middleware should still call next.
        const guestEmitted: Array<{ event: string; payload: unknown }> = [];
        const guestSocket: MockSocket = {
            id: 'socket-guest',
            connected: true,
            handshake: { headers: {} },
            rooms: new Set(),
            join(room: string) {
                this.rooms.add(room);
            },
            leave(room: string) {
                this.rooms.delete(room);
            },
            emit: (event, payload) => guestEmitted.push({ event, payload }),
            on: () => undefined,
            off: () => undefined,
        };

        let guestNext = false;
        await authMiddleware!(guestSocket, () => {
            guestNext = true;
        });
        assert.equal(guestNext, true);
        assert.equal(guestSocket.rooms.has('authenticated'), false);
        assert.equal(guestSocket.rooms.has('status:public'), true);
        await connectionHandler!(guestSocket);
        const guestStatus = guestEmitted.find((entry) => entry.event === 'systemStatus')?.payload as Record<string, unknown>;
        assert.equal(Object.hasOwn(guestStatus, 'debug'), false);
        assert.equal(JSON.stringify(guestStatus).includes('user-1'), false);
        const guestSystem = guestStatus.system as Record<string, unknown>;
        assert.equal(guestSystem.id, 'shadowdark');
        assert.equal(guestSystem.worldDescription, '<p>Campaign introduction</p>');
        assert.equal(guestSystem.worldBackground, 'http://foundry.test/world.webp');
        assert.equal(guestSystem.nextSession, 'Saturday at 7 PM');

        // Reconcile the narrow race where middleware authenticated a token but
        // the service retired it before the connection handler subscribed.
        const raceEmitted: Array<{ event: string; payload: unknown }> = [];
        const raceSocket: MockSocket = {
            id: 'socket-handshake-race',
            connected: true,
            handshake: { headers: { cookie: `${PLAYER_SESSION_COOKIE_NAME}=valid-token` } },
            rooms: new Set(),
            join(room: string) { this.rooms.add(room); },
            leave(room: string) { this.rooms.delete(room); },
            emit: (event, payload) => raceEmitted.push({ event, payload }),
            on: () => undefined,
            off: () => undefined,
        };
        validSession = true;
        await authMiddleware!(raceSocket, () => undefined);
        assert.equal(raceSocket.rooms.has('authenticated'), true);
        validSession = false;
        const attachedBeforeRace = systemAttachedHandlers.length;
        await connectionHandler!(raceSocket);
        assert.equal(raceSocket.rooms.has('authenticated'), false);
        assert.equal(raceSocket.rooms.has('status:public'), true);
        assert.equal(
            raceEmitted.some(entry => entry.event === 'sessionInvalidated'),
            true,
        );
        assert.equal(systemAttachedHandlers.length, attachedBeforeRace);
    } finally {
        (systemService as any).getSystemClient = originalGetSystemClient;
        (systemService as any).isReady = originalIsReady;
        engagementService.setActiveBrowserCount = originalSetActiveBrowserCount;
        userStore.clear('app-socket-gateway-test');
    }
}

// Per ADR-0021 Phase 5 + ADR-0022 Phase 1: a browser socket connecting during
// lifecycle `startup` (systemService.isReady() === false) must NOT attach
// world-backed listeners at connection time. Attachment is deferred until the
// `world:ready` event fires on systemService.
async function runDeferredAttachWhenNotReady() {
    let authMiddleware: ((socket: MockSocket, next: () => void) => Promise<void>) | undefined;
    let connectionHandler: ((socket: MockSocket) => Promise<void>) | undefined;

    const io = {
        engine: { clientsCount: 1 },
        use: (middleware: (socket: MockSocket, next: () => void) => Promise<void>) => {
            authMiddleware = middleware;
        },
        on: (event: string, handler: (socket: MockSocket) => Promise<void>) => {
            if (event === 'connection') connectionHandler = handler;
        },
    };

    const attachedHandlers: Array<{ event: string; handler: EventHandler }> = [];
    const systemAttachedHandlers: Array<{ event: string; handler: EventHandler }> = [];
    const invalidationListeners = new Set<FoundrySessionInvalidationListener>();

    const foundryClient: MockFoundryClient = {
        userId: 'user-1',
        isConnected: true,
        url: 'http://foundry.test',
        on: (event, handler) => attachedHandlers.push({ event, handler }),
        off: () => undefined,
        dispatchDocument: async () => ({}),
        dispatchDocumentSocket: async () => ({}),
    };

    const foundryUserConnections = {
        isCacheReady: () => true,
        isValidSession: (token: string) => token === 'valid-token',
        getOrRestoreSession: async () => ({ client: foundryClient, userId: 'user-1', username: 'tester' }),
        onSessionInvalidated: (listener: FoundrySessionInvalidationListener) => {
            invalidationListeners.add(listener);
            return () => invalidationListeners.delete(listener);
        },
    };

    const originalGetSystemClient = (systemService as any).getSystemClient;
    const originalIsReady = (systemService as any).isReady;
    const originalSetActiveBrowserCount = engagementService.setActiveBrowserCount;
    let ready = false;

    try {
        await userStore.seed(async () => [
            { _id: 'user-1', name: 'Deferred User', role: FoundryUserRole.GAMEMASTER },
        ]);

        (systemService as any).getSystemClient = () => ({
            on: (event: string, handler: EventHandler) => systemAttachedHandlers.push({ event, handler }),
            off: () => undefined,
        });
        (systemService as any).isReady = () => ready;
        engagementService.setActiveBrowserCount = (() => ({
            previousCount: 0, browserCount: 1, becameEngaged: true,
        })) as typeof engagementService.setActiveBrowserCount;

        const socket: MockSocket = {
            id: 'socket-deferred',
            handshake: { headers: { cookie: `${PLAYER_SESSION_COOKIE_NAME}=valid-token` } },
            rooms: new Set(),
            connected: true,
            join(room: string) { this.rooms.add(room); },
            leave(room: string) { this.rooms.delete(room); },
            emit: () => undefined,
            on: () => undefined,
            off: () => undefined,
        } as MockSocket & { connected: boolean; off: (e: string, h: EventHandler) => void };

        registerAppSocketGateway({
            io: io as any,
            foundryUserConnections: foundryUserConnections as any,
            getSystemStatusPayload: async () => ({
                connected: true, worldId: 'w1', initialized: true, isConfigured: true,
                foundryCompatibility: null, users: [],
                system: { id: 'shadowdark', worldTitle: 'Test', status: 'startup' },
                url: 'http://localhost:30000', appVersion: '0.0.0-test',
                debug: { enabled: false, level: 1 },
            } as SystemStatusPayload),
            getPublicStatusPayload: async () => ({
                connected: true, initialized: true, isConfigured: true,
                foundryCompatibility: null, users: [],
                system: { id: null, worldTitle: 'Test', status: 'startup' },
                appVersion: '0.0.0-test',
            }),
            broadcastSystemStatus: () => undefined,
        });

        await authMiddleware!(socket, () => undefined);
        await connectionHandler!(socket);

        // Lifecycle was not ready at connection time, so no world-backed
        // listener attachment happened on the system client.
        assert.equal(systemAttachedHandlers.length, 0);

        // Setup-wide invalidation before readiness must cancel the pending
        // world:ready attachment, not merely filter events after attachment.
        for (const listener of invalidationListeners) {
            listener({ scope: 'all', reason: 'world-entered-setup' });
        }
        await Promise.resolve();
        assert.equal(socket.rooms.has('authenticated'), false);
        assert.equal(socket.rooms.has('status:public'), true);

        // Mark ready and emit `world:ready`. The gateway is listening via
        // `systemService.once('world:ready', ...)`, but revocation removed it.
        ready = true;
        systemService.emit('world:ready', { systemId: 'shadowdark' });

        assert.equal(systemAttachedHandlers.length, 0);
    } finally {
        (systemService as any).getSystemClient = originalGetSystemClient;
        (systemService as any).isReady = originalIsReady;
        engagementService.setActiveBrowserCount = originalSetActiveBrowserCount;
        userStore.clear('app-socket-gateway-deferred-test');
    }
}

export async function run() {
    await runGatewayTests();
    await runDeferredAttachWhenNotReady();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('app-socket-gateway.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
