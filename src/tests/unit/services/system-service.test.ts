import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { SystemService } from '@server/services/world';
import type { CoreSocket } from '@server/core/foundry/sockets/CoreSocket';
import type { WorldTransportController } from '@server/services/world';
import { worldLifecycleStore } from '@server/core/world/WorldLifecycleStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';

function createFakeTransport(): CoreSocket {
    return new EventEmitter() as CoreSocket;
}

function createFakeController(state: { connectCalls: number; disposeCalls: number }): WorldTransportController {
    return {
        connect: async () => {
            state.connectCalls += 1;
        },
        dispose: () => {
            state.disposeCalls += 1;
        },
        startHeartbeat: () => undefined,
        stopHeartbeat: () => undefined,
        disconnect: () => undefined,
        launchWorld: async (worldId: string) => ({ accepted: true, response: { worldId } }),
        shutdownWorld: async () => ({ accepted: true, response: { shutdown: true } }),
        withHeartbeatPaused: async <T>(operation: () => Promise<T>) => operation(),
        resetRetryBackoff: () => undefined,
    } as unknown as WorldTransportController;
}

async function runInitializeWiringTest() {
    worldLifecycleStore.reset('system-service-test');
    worldStateStore.clear('system-service-test');

    const fakeTransport = createFakeTransport();
    const controllerState = { connectCalls: 0, disposeCalls: 0 };
    let createClientCalls = 0;
    let attachCalls = 0;
    let controllerTransport: CoreSocket | null = null;
    let statusUpdate: (() => void) | null = null;
    let statusEvents = 0;
    const teardownReasons: string[] = [];

    const service = SystemService.createForTests({
        createSystemClient: () => {
            createClientCalls += 1;
            return fakeTransport;
        },
        attachFoundryEventIngress: (transport, options) => {
            attachCalls += 1;
            assert.equal(transport, fakeTransport);
            statusUpdate = options.onStatusUpdate;
            return () => undefined;
        },
        createWorldTransportController: ({ transport }) => {
            controllerTransport = transport;
            return createFakeController(controllerState);
        },
        loadSetupCache: async () => ({
            currentWorldId: 'cached-world',
            worlds: {
                'cached-world': {
                    worldId: 'cached-world',
                    worldTitle: 'Cached World',
                    worldDescription: null,
                    systemId: 'dnd5e',
                    backgroundUrl: null,
                    users: [],
                    lastUpdated: '2026-05-30T00:00:00.000Z',
                },
            },
        }),
        teardownWorldRuntime: (reason) => {
            teardownReasons.push(reason);
        },
    });

    service.on('system:status-update', () => {
        statusEvents += 1;
    });

    await service.initialize({ url: 'http://foundry.test' });
    await service.initialize({ url: 'http://foundry.test' });

    assert.equal(createClientCalls, 1);
    assert.equal(attachCalls, 1);
    assert.equal(controllerTransport, fakeTransport);
    assert.equal(controllerState.connectCalls, 1);
    assert.equal(controllerState.disposeCalls, 0);
    assert.equal(service.getSystemClient(), fakeTransport);
    assert.equal(worldStateStore.getCachedWorldData()?.worldId, 'cached-world');

    const emitStatusUpdate = statusUpdate as (() => void) | null;
    assert.ok(emitStatusUpdate);
    emitStatusUpdate();
    assert.equal(statusEvents, 1);

    fakeTransport.emit('disconnect');
    assert.deepEqual(teardownReasons, ['world-disconnected']);

    // Every lifecycle transition must reach the status broadcaster, including
    // transitions observed while no authenticated Foundry user session exists.
    for (const lifecycleState of ['closed', 'setup', 'startup', 'active'] as const) {
        const previousStatusEvents: number = statusEvents;
        worldLifecycleStore.setState(lifecycleState, 'system-service-test');
        assert.equal(statusEvents, previousStatusEvents + 1);
    }

    worldLifecycleStore.reset('system-service-test');
    worldStateStore.clear('system-service-test');
}

export async function run() {
    await runInitializeWiringTest();
    console.log('  - SystemService: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('system-service.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
