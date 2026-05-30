import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { WorldTransportController } from '@server/services/world';
import { EngagementService } from '@server/services/world';
import { worldLifecycleStore } from '@server/core/world/WorldLifecycleStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';

class FakeTransport extends EventEmitter {
    public isConnected = false;
    public isConnectionAttemptInFlight = false;
    public connectCalls = 0;
    public disconnectCalls = 0;
    public setupPayloads: Record<string, unknown>[] = [];
    public setupResponse: unknown = { ok: true };
    public setupError: Error | null = null;

    public async connect(): Promise<void> {
        this.connectCalls += 1;
    }

    public disconnect(): void {
        this.disconnectCalls += 1;
        this.isConnected = false;
    }

    public async checkStatus() {
        return { csrfToken: null, isSetupMatch: true, pageTitle: 'Setup' };
    }

    public async postSetupAction(payload: Record<string, unknown>): Promise<unknown> {
        this.setupPayloads.push(payload);
        if (this.setupError) throw this.setupError;
        return this.setupResponse;
    }
}

function resetWorldState(): void {
    worldStateStore.clear('world-transport-controller-test');
    worldLifecycleStore.reset('world-transport-controller-test');
}

function createController() {
    const transport = new FakeTransport();
    const engagement = new EngagementService({ now: () => 1000 });
    const controller = new WorldTransportController({
        transport: transport as any,
        engagement,
    });
    return { controller, transport, engagement };
}

async function runWorldControlTests() {
    resetWorldState();
    const { controller, transport } = createController();

    try {
        const launch = await controller.launchWorld('world-1');
        assert.equal(launch.accepted, true);
        assert.deepEqual(transport.setupPayloads[0], { action: 'launchWorld', world: 'world-1' });

        transport.setupError = new Error('Foundry rejected request');
        await assert.rejects(() => controller.launchWorld('world-2'), /Foundry rejected request/);
        assert.deepEqual(transport.setupPayloads[1], { action: 'launchWorld', world: 'world-2' });

        transport.setupError = null;
        const teardownReasons: string[] = [];
        transport.on('foundry:runtimeTeardown', (event: { reason: string }) => {
            teardownReasons.push(event.reason);
        });

        const shutdown = await controller.shutdownWorld();
        assert.equal(shutdown.accepted, true);
        assert.deepEqual(transport.setupPayloads[2], { shutdown: true });
        assert.equal(worldLifecycleStore.getState(), 'setup');
        assert.deepEqual(teardownReasons, ['admin-shutdown']);
        assert.equal(transport.disconnectCalls, 1);
    } finally {
        controller.dispose();
        resetWorldState();
    }
}

async function runTransportFactTests() {
    resetWorldState();
    const { controller, transport } = createController();

    try {
        transport.emit('foundry:worldDiscovered', {
            world: { id: 'world-1', title: 'World One' },
            userCount: 3,
        });
        assert.equal(worldLifecycleStore.getState(), 'startup');
        assert.equal(worldStateStore.getProbeData()?.title, 'World One');
        assert.equal(worldStateStore.getProbeUserCount(), 3);

        transport.emit('foundry:worldActive');
        assert.equal(worldLifecycleStore.getState(), 'startup');
        assert.equal(worldStateStore.getProbeData(), null);

        const teardownReasons: string[] = [];
        transport.on('foundry:runtimeTeardown', (event: { reason: string }) => {
            teardownReasons.push(event.reason);
        });

        transport.emit('foundry:transportDisconnected', { reason: 'transport close' });
        assert.equal(worldLifecycleStore.getState(), 'offline');
        assert.deepEqual(teardownReasons, ['core-disconnect']);
    } finally {
        controller.dispose();
        resetWorldState();
    }
}

export async function run() {
    await runWorldControlTests();
    await runTransportFactTests();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('world-transport-controller.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
