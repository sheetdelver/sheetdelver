import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { adventureStore } from '@server/core/documents/primary/adventures/AdventureStore';
import { fogExplorationStore } from '@server/core/documents/primary/fog-explorations/FogExplorationStore';
import {
    DOCUMENT_VISIBILITY,
    DocumentOwnershipLevel,
    FoundryUserRole,
    type ResolvedDocumentOwnershipLevel,
} from '@server/core/documents/primary/base/ownership';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { sceneStore } from '@server/core/documents/primary/scenes/SceneStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { registerAppSocketGateway } from '@server/realtime/AppSocketGateway';
import { PLAYER_SESSION_COOKIE_NAME } from '@server/security/playerSessionCookie';
import type { FoundrySessionInvalidationEvent } from '@server/shared/types/foundry';
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
        engine: { clientsCount: 3 },
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
    const gmClient = {
        ...ownerClient,
        userId: 'gm-user',
    };
    const foundryUserConnections = {
        isCacheReady: () => true,
        isValidSession: (token: string) => ['owner-token', 'other-token', 'gm-token'].includes(token),
        onSessionInvalidated: (_listener: (event: FoundrySessionInvalidationEvent) => void) => () => undefined,
        getOrRestoreSession: async (token: string) => {
            if (token === 'owner-token') {
                return { client: ownerClient, userId: 'owner-user', username: 'owner' };
            }
            if (token === 'other-token') {
                return { client: otherClient, userId: 'other-user', username: 'other' };
            }
            if (token === 'gm-token') {
                return { client: gmClient, userId: 'gm-user', username: 'gm' };
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
    const gmBrowser = createBrowserSocket('gm-browser', 'gm-token');

    try {
        await userStore.seed(async () => [
            { _id: 'owner-user', name: 'Owner', role: FoundryUserRole.PLAYER },
            { _id: 'other-user', name: 'Other', role: FoundryUserRole.PLAYER },
            { _id: 'gm-user', name: 'GM', role: FoundryUserRole.GAMEMASTER },
        ]);
        await actorStore.seed(async () => [
            {
                _id: 'actor-sync',
                name: 'Before',
                type: 'character',
                ownership: {
                    default: 0,
                    'owner-user': 3,
                },
            },
            {
                _id: 'actor-delete',
                name: 'Delete Me',
                type: 'character',
                ownership: {
                    default: DocumentOwnershipLevel.NONE,
                    'owner-user': DocumentOwnershipLevel.OWNER,
                },
            },
        ]);
        await sceneStore.seed(async () => [{
            _id: 'scene-sync',
            name: 'Before Scene',
            ownership: {
                default: DocumentOwnershipLevel.NONE,
                'owner-user': DocumentOwnershipLevel.OWNER,
            },
            tokens: [],
        }]);
        await settingStore.seed(async () => [{
            _id: 'setting-sync',
            key: 'core.syntheticSetting',
            value: '"before"',
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
        await authMiddleware!(gmBrowser.socket, () => undefined);
        await connectionHandler!(ownerBrowser.socket);
        await connectionHandler!(otherBrowser.socket);
        await connectionHandler!(gmBrowser.socket);

        // Every active Store now has changed/list signal parity. Unsupported
        // Adventure and FogExploration remain absent from the expected set.
        const registeredEvents = new Set(
            systemClient.eventNames().filter((event): event is string => typeof event === 'string'),
        );
        const missingEvents = EXPECTED_BROWSER_STORE_EVENTS.filter((event) => !registeredEvents.has(event));
        assert.deepEqual(missingEvents, []);

        foundryTransport.emit('foundry:modifyDocument', {
            response: {
                type: 'Actor',
                action: 'update',
                operation: {
                    updates: [{ _id: 'actor-sync', name: 'After' }],
                },
                result: [{ _id: 'actor-sync', name: 'After' }],
            },
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
        assert.equal(
            gmBrowser.emitted.some((entry) => entry.event === 'actorChanged'),
            true,
            'implicit GM ownership is honored by the Store audience policy',
        );

        // Delete routing must use the document snapshot that existed before
        // removal. Otherwise the gateway cannot notify authorized viewers and
        // may leak the tombstone identifier to unrelated authenticated users.
        const priorActorEvents = new Map([
            ['owner', ownerBrowser.emitted.length],
            ['other', otherBrowser.emitted.length],
            ['gm', gmBrowser.emitted.length],
        ]);
        foundryTransport.emit('foundry:modifyDocument', {
            response: {
                type: 'Actor',
                action: 'delete',
                result: ['actor-delete'],
            },
        });
        const receivedDeletedActor = (
            entries: Array<{ event: string; payload: unknown }>,
            start: number,
        ) => entries.slice(start).some((entry) => {
            const payload = entry.payload as { actorId?: string; action?: string };
            return entry.event === 'actorChanged'
                && payload.actorId === 'actor-delete'
                && payload.action === 'delete';
        });
        assert.equal(actorStore.get('actor-delete'), null);
        assert.equal(receivedDeletedActor(ownerBrowser.emitted, priorActorEvents.get('owner')!), true);
        assert.equal(receivedDeletedActor(gmBrowser.emitted, priorActorEvents.get('gm')!), true);
        assert.equal(
            receivedDeletedActor(otherBrowser.emitted, priorActorEvents.get('other')!),
            false,
            'an unrelated player never receives the private deleted Actor id',
        );

        // Feed each incoming ownership value through the exact CoreSocket
        // envelope. Production code reads the response value; this matrix
        // guards against accidentally specializing convergence for one level.
        const otherSubject = userStore.createAccessSubject('other-user');
        assert.ok(otherSubject);
        const ownershipTransitions: ResolvedDocumentOwnershipLevel[] = [
            DocumentOwnershipLevel.OWNER,
            DocumentOwnershipLevel.LIMITED,
            DocumentOwnershipLevel.OBSERVER,
            DocumentOwnershipLevel.NONE,
        ];
        for (const level of ownershipTransitions) {
            const ownership = {
                default: DocumentOwnershipLevel.NONE,
                'owner-user': DocumentOwnershipLevel.OWNER,
                'other-user': level,
            };
            foundryTransport.emit('foundry:modifyDocument', {
                response: {
                    type: 'Actor',
                    action: 'update',
                    operation: { updates: [{ _id: 'actor-sync', ownership }] },
                    // Foundry v14 returns replacement DataFieldOperators in
                    // this serialized form. Ingress must preserve the wire
                    // value until the Store applies its database semantics.
                    result: [{
                        _id: 'actor-sync',
                        ownership: {
                            '__$OPERATOR$__': 'ForcedReplacement',
                            value: ownership,
                        },
                    }],
                },
            });

            const visibleAt = (threshold: ResolvedDocumentOwnershipLevel): boolean => actorStore.listActors({
                subject: otherSubject!,
                minOwnership: threshold,
            }).some(actor => actor._id === 'actor-sync');
            assert.equal(
                visibleAt(DOCUMENT_VISIBILITY.LIST_VISIBLE),
                level >= DOCUMENT_VISIBILITY.LIST_VISIBLE,
                `LIST visibility must follow incoming ownership level ${level}`,
            );
            assert.equal(
                visibleAt(DOCUMENT_VISIBILITY.DETAIL_VISIBLE),
                level >= DOCUMENT_VISIBILITY.DETAIL_VISIBLE,
                `DETAIL visibility must follow incoming ownership level ${level}`,
            );
            assert.equal(
                visibleAt(DOCUMENT_VISIBILITY.WRITEABLE),
                level >= DOCUMENT_VISIBILITY.WRITEABLE,
                `WRITE visibility must follow incoming ownership level ${level}`,
            );
        }
        assert.deepEqual(
            actorStore.get('actor-sync')?.ownership,
            {
                default: DocumentOwnershipLevel.NONE,
                'owner-user': DocumentOwnershipLevel.OWNER,
                'other-user': DocumentOwnershipLevel.NONE,
            },
            'the cached Actor contains ownership values, not v14 operator metadata',
        );

        // Foundry v13 expresses the same whole-field replacement with the
        // legacy `==` key. Omitted overrides must disappear on this path too.
        foundryTransport.emit('foundry:modifyDocument', {
            response: {
                type: 'Actor',
                action: 'update',
                result: [{
                    _id: 'actor-sync',
                    '==ownership': {
                        default: DocumentOwnershipLevel.NONE,
                        'owner-user': DocumentOwnershipLevel.OWNER,
                    },
                }],
            },
        });
        assert.equal(
            Object.hasOwn(actorStore.get('actor-sync')?.ownership ?? {}, 'other-user'),
            false,
            'v13 replacement removes an omitted ownership override',
        );
        assert.equal(
            otherBrowser.emitted.some((entry) => {
                const payload = entry.payload as { actorId?: string };
                return entry.event === 'actorListInvalidated' && payload.actorId === 'actor-sync';
            }),
            true,
            'ownership transitions reach the affected browser as list invalidations',
        );
        assert.equal(
            ownerBrowser.emitted.some((entry) => {
                const payload = entry.payload as { actorId?: string };
                return entry.event === 'actorListInvalidated' && payload.actorId === 'actor-sync';
            }),
            false,
            'ownership invalidations do not leak to an unaffected browser',
        );

        foundryTransport.emit('foundry:modifyDocument', {
            response: {
                type: 'Scene',
                action: 'update',
                result: [{ _id: 'scene-sync', name: 'After Scene' }],
            },
        });
        assert.equal(sceneStore.get('scene-sync')?.name, 'After Scene');
        assert.equal(
            ownerBrowser.emitted.some((entry) => entry.event === 'sceneChanged'),
            true,
            'an owning player receives an authorized Scene invalidation',
        );
        assert.equal(
            otherBrowser.emitted.some((entry) => entry.event === 'sceneChanged'),
            false,
            'a non-owning player does not receive a Scene invalidation',
        );

        foundryTransport.emit('foundry:modifyDocument', {
            response: {
                type: 'Scene',
                action: 'update',
                result: [{
                    _id: 'scene-sync',
                    ownership: {
                        '__$OPERATOR$__': 'ForcedReplacement',
                        value: {
                            default: DocumentOwnershipLevel.NONE,
                            'owner-user': DocumentOwnershipLevel.OWNER,
                            'other-user': DocumentOwnershipLevel.OBSERVER,
                        },
                    },
                }],
            },
        });
        assert.equal(
            otherBrowser.emitted.some((entry) => entry.event === 'sceneListInvalidated'),
            true,
            'a Scene ownership change reaches the newly authorized player',
        );
        assert.equal(
            ownerBrowser.emitted.some((entry) => entry.event === 'sceneListInvalidated'),
            false,
            'a targeted Scene list invalidation excludes an unchanged owner',
        );

        let settingBridgeEvents = 0;
        systemClient.on('settingChanged', () => {
            settingBridgeEvents += 1;
        });
        foundryTransport.emit('foundry:modifyDocument', {
            response: {
                type: 'Setting',
                action: 'update',
                result: [{ _id: 'setting-sync', value: '"after"' }],
            },
        });
        assert.equal(settingStore.getValueByKey('core.syntheticSetting'), 'after');
        assert.equal(settingBridgeEvents, 1, 'Setting Store changes reach the system bridge');
        assert.equal(
            ownerBrowser.emitted.some((entry) => entry.event === 'settingChanged'),
            false,
            'a player never receives GM-only Setting identifiers',
        );
        assert.equal(
            otherBrowser.emitted.some((entry) => entry.event === 'settingChanged'),
            false,
            'another player never receives GM-only Setting identifiers',
        );
        assert.equal(
            gmBrowser.emitted.some((entry) => entry.event === 'settingChanged'),
            true,
            'the Setting Store type policy routes its invalidation to a GM',
        );

        // The explicitly unsupported Stores stay outside generic ingress.
        foundryTransport.emit('foundry:modifyDocument', {
            response: {
                type: 'Adventure',
                action: 'create',
                result: [{ _id: 'unsupported-adventure' }],
            },
        });
        foundryTransport.emit('foundry:modifyDocument', {
            response: {
                type: 'FogExploration',
                action: 'create',
                result: [{ _id: 'unsupported-fog' }],
            },
        });
        assert.equal(adventureStore.get('unsupported-adventure'), null);
        assert.equal(fogExplorationStore.get('unsupported-fog'), null);
    } finally {
        ownerBrowser.disconnect();
        otherBrowser.disconnect();
        gmBrowser.disconnect();
        detachIngress();
        actorStore.clear('document-sync-characterization');
        userStore.clear('document-sync-characterization');
        sceneStore.clear('document-sync-characterization');
        settingStore.clear('document-sync-characterization');
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
