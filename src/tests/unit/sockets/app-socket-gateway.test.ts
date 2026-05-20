import { strict as assert } from 'node:assert';
import { registerAppSocketGateway } from '@server/realtime/AppSocketGateway';
import { systemService } from '@core/system/SystemService';
import { engagementService } from '@server/services/world';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { FoundryUserRole } from '@server/core/documents/primary/base/ownership';
import type { SystemStatusPayload } from '@shared/contracts/status';

type EventHandler = (...args: unknown[]) => void;

interface MockSocket {
    id: string;
    handshake: { auth?: { token?: string } };
    rooms: Set<string>;
    join: (room: string) => void;
    emit: (event: string, payload?: unknown) => void;
    on: (event: string, handler: EventHandler) => void;
    userSession?: unknown;
    foundryClient?: MockFoundryClient;
}

interface MockFoundryClient {
    userId?: string | null;
    username?: string;
    on: (event: string, handler: EventHandler) => void;
    off: (event: string, handler: EventHandler) => void;
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
        username: 'tester',
        on: (event, handler) => attachedHandlers.push({ event, handler }),
        off: (event, handler) => detachedHandlers.push({ event, handler }),
    };

    const sessionManager = {
        isCacheReady: () => true,
        getOrRestoreSession: async (token: string) => {
            if (token === 'valid-token') {
                return { client: foundryClient, userId: 'user-1' };
            }
            return undefined;
        },
    };

    const originalGetSystemClient = (systemService as any).getSystemClient;
    const originalSetActiveBrowserCount = engagementService.setActiveBrowserCount;
    const browserCounts: number[] = [];

    try {
        await userStore.seed(async () => [
            { _id: 'user-1', name: 'Gateway User', role: FoundryUserRole.GAMEMASTER },
        ]);

        (systemService as any).getSystemClient = () => ({
            on: (event: string, handler: EventHandler) => systemAttachedHandlers.push({ event, handler }),
            off: (event: string, handler: EventHandler) => systemDetachedHandlers.push({ event, handler }),
        });
        engagementService.setActiveBrowserCount = ((count: number) => {
            browserCounts.push(count);
            return { previousCount: 0, browserCount: count, becameEngaged: count > 0 };
        }) as typeof engagementService.setActiveBrowserCount;

        const emitted: Array<{ event: string; payload: unknown }> = [];
        let disconnectHandler: EventHandler | undefined;

        const socket: MockSocket = {
            id: 'socket-1',
            handshake: { auth: { token: 'valid-token' } },
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
            sessionManager,
            getSystemStatusPayload: async () => ({
                connected: true,
                worldId: 'w1',
                initialized: true,
                isConfigured: true,
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
        // Per-user foundry client now receives worldShutdown/worldReload only (2).
        // ADR-0014 Phase 3 moved shared-content fan-out off the per-user
        // foundryClient onto SharedContentStore.onSharedContentChanged; the
        // gateway subscribes to the Store directly so per-session foundryClient
        // emits are not part of this count.
        // User presence/status now broadcasts once from the system client path.
        // combatUpdate moved off the per-user client onto the system bridge in Phase 5.
        // The system client carries Store-bridged events (Phase 7 closure):
        //   actorChanged + chatMessageChanged + chatMessageListInvalidated
        //   + userChanged + userListInvalidated + folderChanged + folderListInvalidated
        //   + journalChanged + journalListInvalidated
        //   + combatChanged + combatListInvalidated
        //   + itemChanged + itemListInvalidated
        //   + rollTableChanged + rollTableListInvalidated
        //   + macroChanged + macroListInvalidated
        //   + playlistChanged + playlistListInvalidated
        //   + cardsChanged + cardsListInvalidated = 21.
        assert.equal(attachedHandlers.length, 2);
        assert.equal(systemAttachedHandlers.length, 21);
        assert.ok(browserCounts.includes(1));

        io.engine.clientsCount = 0;
        disconnectHandler?.();

        assert.equal(detachedHandlers.length, 2);
        assert.equal(systemDetachedHandlers.length, 21);
        assert.ok(browserCounts.includes(0));

        // Guest degradation path (no token): middleware should still call next.
        const guestSocket: MockSocket = {
            id: 'socket-guest',
            handshake: { auth: {} },
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
        engagementService.setActiveBrowserCount = originalSetActiveBrowserCount;
        userStore.clear('app-socket-gateway-test');
    }
}

export async function run() {
    await runGatewayTests();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('app-socket-gateway.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
