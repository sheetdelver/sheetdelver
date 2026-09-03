import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { adventureStore } from '@server/core/documents/primary/adventures/AdventureStore';
import { fogExplorationStore } from '@server/core/documents/primary/fog-explorations/FogExplorationStore';
import { FoundryUserRole } from '@server/core/documents/primary/base/ownership';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { registerAppSocketGateway } from '@server/realtime/AppSocketGateway';
import { PLAYER_SESSION_COOKIE_NAME } from '@server/security/playerSessionCookie';
import { engagementService, FoundryEventIngress, systemService } from '@server/services/world';
import type { SystemStatusPayload } from '@shared/contracts/status';

type EventHandler = (...args: unknown[]) => void;

const EXPECTED_BROWSER_STORE_EVENTS = [
    'actorChanged',
    'actorListInvalidated',
    'chatMessageChanged',
    'chatMessageListInvalidated',
    'userChanged',
    'userListInvalidated',
    'folderChanged',
    'folderListInvalidated',
    'journalChanged',
    'journalListInvalidated',
    'combatChanged',
    'combatListInvalidated',
    'itemChanged',
    'itemListInvalidated',
    'rollTableChanged',
    'rollTableListInvalidated',
    'macroChanged',
    'macroListInvalidated',
    'playlistChanged',
    'playlistListInvalidated',
    'cardsChanged',
    'cardsListInvalidated',
    'sceneChanged',
    'sceneListInvalidated',
    'settingChanged',
    'settingListInvalidated',
] as const;

interface TestSocket {
    id: string;
    connected: boolean;
    handshake: { headers: { cookie: string } };
    rooms: Set<string>;
    userSession?: unknown;
    foundryClient?: unknown;
    join: (room: string) => void;
    emit: (event: string, payload?: unknown) => void;
    on: (event: string, handler: EventHandler) => void;
}

class RecordingSystemClient extends EventEmitter {}

class FoundryTransport extends EventEmitter {}

function createBrowserSocket(id: string, token: string) {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const handlers = new Map<string, EventHandler[]>();

    const socket: TestSocket = {
        id,
        connected: true,
        handshake: {
            headers: {
                cookie: `${PLAYER_SESSION_COOKIE_NAME}=${token}`,
            },
        },
        rooms: new Set(),
        join(room) {
            this.rooms.add(room);
        },
        emit(event, payload) {
            emitted.push({ event, payload });
        },
        on(event, handler) {
            const existing = handlers.get(event) ?? [];
            existing.push(handler);
            handlers.set(event, existing);
        },
    };

    return {
        socket,
        emitted,
        disconnect() {
            socket.connected = false;
            for (const handler of handlers.get('disconnect') ?? []) handler();
        },
    };
}

function statusPayload(): SystemStatusPayload {
    return {
        connected: true,
        worldId: 'sync-world',
        initialized: true,
        isConfigured: true,
        foundryCompatibility: null,
        users: [],
        system: {
            id: 'synthetic',
            worldTitle: 'Synchronization Test',
            status: 'active',
        },
        url: 'http://foundry.test',
        appVersion: '0.0.0-test',
        debug: { enabled: false, level: 1 },
    };
}

async function runIngressToAuthorizedBrowserHarness() {
    let authMiddleware: ((socket: TestSocket, next: () => void) => Promise<void>) | undefined;
    let connectionHandler: ((socket: TestSocket) => Promise<void>) | undefined;

    const io = {
        engine: { clientsCount: 2 },
        use(handler: (socket: TestSocket, next: () => void) => Promise<void>) {
            authMiddleware = handler;
        },
        on(event: string, handler: (socket: TestSocket) => Promise<void>) {
            if (event === 'connection') connectionHandler = handler;
        },
    };

    const systemClient = new RecordingSystemClient();
    const foundryTransport = new FoundryTransport();
    const ownerClient = {
        userId: 'owner-user',
        isConnected: true,
        url: 'http://foundry.test',
        on: () => undefined,
        off: () => undefined,
        dispatchDocument: async () => ({}),
        dispatchDocumentSocket: async () => ({}),
    };
    const otherClient = {
        ...ownerClient,
        userId: 'other-user',
    };
    const foundryUserConnections = {
        isCacheReady: () => true,
        getOrRestoreSession: async (token: string) => {
            if (token === 'owner-token') {
                return { client: ownerClient, userId: 'owner-user', username: 'owner' };
            }
            if (token === 'other-token') {
                return { client: otherClient, userId: 'other-user', username: 'other' };
            }
            return undefined;
        },
    };

    const serviceState = systemService as unknown as {
        systemClient: RecordingSystemClient | null;
        isReady: () => boolean;
    };
    const originalSystemClient = serviceState.systemClient;
    const originalIsReady = serviceState.isReady;
    const originalEngagementCounter = engagementService.setActiveBrowserCount;
    const ingress = new FoundryEventIngress();
    const detachIngress = ingress.attach(foundryTransport);
    const ownerBrowser = createBrowserSocket('owner-browser', 'owner-token');
    const otherBrowser = createBrowserSocket('other-browser', 'other-token');

    try {
        await userStore.seed(async () => [
            { _id: 'owner-user', name: 'Owner', role: FoundryUserRole.PLAYER },
            { _id: 'other-user', name: 'Other', role: FoundryUserRole.PLAYER },
        ]);
        await actorStore.seed(async () => [{
            _id: 'actor-sync',
            name: 'Before',
            type: 'character',
            ownership: {
                default: 0,
                'owner-user': 3,
            },
        }]);

        serviceState.systemClient = systemClient;
        serviceState.isReady = () => true;
        engagementService.setActiveBrowserCount = (() => ({
            previousCount: 0,
            browserCount: 2,
            becameEngaged: true,
        })) as typeof engagementService.setActiveBrowserCount;

        registerAppSocketGateway({
            io: io as never,
            foundryUserConnections: foundryUserConnections as never,
            getSystemStatusPayload: async () => statusPayload(),
            getPublicStatusPayload: async () => ({
                connected: true,
                initialized: true,
                isConfigured: true,
                foundryCompatibility: null,
                users: [],
                system: {
                    id: 'synthetic',
                    worldTitle: 'Synchronization Test',
                    status: 'active',
                },
                appVersion: '0.0.0-test',
            }),
            broadcastSystemStatus: () => undefined,
        });

        assert.ok(authMiddleware);
        assert.ok(connectionHandler);

        await authMiddleware!(ownerBrowser.socket, () => undefined);
        await authMiddleware!(otherBrowser.socket, () => undefined);
        await connectionHandler!(ownerBrowser.socket);
        await connectionHandler!(otherBrowser.socket);

        // This records the current gap without pretending event parity is
        // complete. Phase 2 changes the expected missing set to empty.
        const registeredEvents = new Set(
            systemClient.eventNames().filter((event): event is string => typeof event === 'string'),
        );
        const missingEvents = EXPECTED_BROWSER_STORE_EVENTS.filter((event) => !registeredEvents.has(event));
        assert.deepEqual(missingEvents, [
            'actorListInvalidated',
            'sceneChanged',
            'sceneListInvalidated',
            'settingChanged',
            'settingListInvalidated',
        ]);

        foundryTransport.emit('foundry:modifyDocument', {
            type: 'Actor',
            action: 'update',
            operation: {
                updates: [{ _id: 'actor-sync', name: 'After' }],
            },
            result: [{ _id: 'actor-sync', name: 'After' }],
        });

        assert.equal(actorStore.get('actor-sync')?.name, 'After');
        assert.equal(
            ownerBrowser.emitted.some((entry) => entry.event === 'actorChanged'),
            true,
            'the authorized owner receives the Store-backed invalidation',
        );
        assert.equal(
            otherBrowser.emitted.some((entry) => entry.event === 'actorChanged'),
            false,
            'a non-owner does not receive the document-specific invalidation',
        );

        // The explicitly unsupported Stores stay outside generic ingress.
        foundryTransport.emit('foundry:modifyDocument', {
            type: 'Adventure',
            action: 'create',
            result: [{ _id: 'unsupported-adventure' }],
        });
        foundryTransport.emit('foundry:modifyDocument', {
            type: 'FogExploration',
            action: 'create',
            result: [{ _id: 'unsupported-fog' }],
        });
        assert.equal(adventureStore.get('unsupported-adventure'), null);
        assert.equal(fogExplorationStore.get('unsupported-fog'), null);
    } finally {
        ownerBrowser.disconnect();
        otherBrowser.disconnect();
        detachIngress();
        actorStore.clear('document-sync-characterization');
        userStore.clear('document-sync-characterization');
        adventureStore.clear('document-sync-characterization');
        fogExplorationStore.clear('document-sync-characterization');
        serviceState.systemClient = originalSystemClient;
        serviceState.isReady = originalIsReady;
        engagementService.setActiveBrowserCount = originalEngagementCounter;
    }
}

export async function run() {
    await runIngressToAuthorizedBrowserHarness();
    console.log('  - document synchronization vertical characterization: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('document-synchronization-characterization.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
