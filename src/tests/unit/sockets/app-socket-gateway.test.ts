import { strict as assert } from 'node:assert';
import { registerAppSocketGateway } from '@server/realtime/AppSocketGateway';
import { systemService } from '@server/services/world';
import { engagementService } from '@server/services/world';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { FoundryUserRole } from '@server/core/documents/primary/base/ownership';
import type { SystemStatusPayload } from '@shared/contracts/status';
import { PLAYER_SESSION_COOKIE_NAME } from '@server/security/playerSessionCookie';

type EventHandler = (...args: unknown[]) => void;

interface MockSocket {
    id: string;
    handshake: { headers: { cookie?: string } };
    rooms: Set<string>;
    join: (room: string) => void;
    emit: (event: string, payload?: unknown) => void;
    on: (event: string, handler: EventHandler) => void;
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
        getOrRestoreSession: async (token: string) => {
            if (token === 'valid-token') {
                return { client: foundryClient, userId: 'user-1', username: 'tester' };
            }
            return undefined;
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
        let disconnectHandler: EventHandler | undefined;

        const socket: MockSocket = {
            id: 'socket-1',
            handshake: { headers: { cookie: `${PLAYER_SESSION_COOKIE_NAME}=valid-token` } },
            rooms: new Set(),
            join(room: string) {
                this.rooms.add(room);
            },
            emit(event: string, payload?: unknown) {
                emitted.push({ event, payload });
            },
            on(event: string, handler: EventHandler) {
                if (event === 'disconnect') disconnectHandler = handler;
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
        //   actorChanged + chatMessageChanged + chatMessageListInvalidated
        //   + userChanged + userListInvalidated + folderChanged + folderListInvalidated
        //   + journalChanged + journalListInvalidated
        //   + combatChanged + combatListInvalidated
        //   + itemChanged + itemListInvalidated
        //   + rollTableChanged + rollTableListInvalidated
        //   + macroChanged + macroListInvalidated
        //   + playlistChanged + playlistListInvalidated
        //   + cardsChanged + cardsListInvalidated = 21.
        assert.equal(attachedHandlers.length, 0);
        assert.equal(systemAttachedHandlers.length, 21);
        assert.ok(browserCounts.includes(1));

        const userChanged = systemAttachedHandlers.find((entry) => entry.event === 'userChanged')?.handler;
        assert.ok(userChanged);

        worldReady = false;
        userChanged!({ userId: 'user-1', action: 'update' });
        assert.equal(emitted.some((entry) => entry.event === 'userChanged'), false);

        worldReady = true;
        userChanged!({ userId: 'user-1', action: 'update' });
        assert.equal(emitted.some((entry) => entry.event === 'userChanged'), true);

        io.engine.clientsCount = 0;
        disconnectHandler?.();

        assert.equal(detachedHandlers.length, 0);
        assert.equal(systemDetachedHandlers.length, 21);
        assert.ok(browserCounts.includes(0));

        // Guest degradation path (no cookie): middleware should still call next.
        const guestSocket: MockSocket = {
            id: 'socket-guest',
            handshake: { headers: {} },
            rooms: new Set(),
            join(room: string) {
                this.rooms.add(room);
            },
            emit: () => undefined,
            on: () => undefined,
        };

        let guestNext = false;
        await authMiddleware!(guestSocket, () => {
            guestNext = true;
        });
        assert.equal(guestNext, true);
        assert.equal(guestSocket.rooms.has('authenticated'), false);
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
        getOrRestoreSession: async () => ({ client: foundryClient, userId: 'user-1', username: 'tester' }),
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
            broadcastSystemStatus: () => undefined,
        });

        await authMiddleware!(socket, () => undefined);
        await connectionHandler!(socket);

        // Lifecycle was not ready at connection time, so no world-backed
        // listener attachment happened on the system client.
        assert.equal(systemAttachedHandlers.length, 0);

        // Mark ready and emit `world:ready`. The gateway is listening via
        // `systemService.once('world:ready', ...)` and should attach now.
        ready = true;
        systemService.emit('world:ready', { systemId: 'shadowdark' });

        // After readiness fires, the 21 system-client listeners are attached.
        assert.equal(systemAttachedHandlers.length, 21);
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
