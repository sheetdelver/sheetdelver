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
    public onPostSetupAction: (() => void) | null = null;
    public statusResponse = {
        csrfToken: null as string | null,
        isSetupMatch: true,
        pageTitle: 'Setup',
    };

    public async connect(): Promise<void> {
        this.connectCalls += 1;
    }

    public disconnect(): void {
        this.disconnectCalls += 1;
        this.isConnected = false;
    }

    public async checkStatus() {
        return this.statusResponse;
    }

    public async postSetupAction(payload: Record<string, unknown>): Promise<unknown> {
        this.setupPayloads.push(payload);
        this.onPostSetupAction?.();
        if (this.setupError) throw this.setupError;
        return this.setupResponse;
    }
}

async function runNativeShutdownRedirectTest() {
    resetWorldState();
    const { controller, transport } = createController(() => true);
    const teardowns: string[] = [];
    transport.on('foundry:runtimeTeardown', (event: { reason: string }) => teardowns.push(event.reason));
    try {
        transport.setupError = new Error('Foundry setup request failed with status 302');
        await assert.rejects(() => controller.shutdownWorld(), /status 302/,
            'a redirect without native shutdown is not proof of success');
        assert.deepEqual(teardowns, []);

        transport.onPostSetupAction = () => transport.emit('foundry:shutdown');
        const shutdown = await controller.shutdownWorld();
        assert.equal(shutdown.accepted, true);
        assert.deepEqual(shutdown.response, { nativeShutdown: true });
        assert.equal(worldLifecycleStore.getState(), 'setup');
        assert.deepEqual(teardowns, ['foundry-shutdown'],
            'native shutdown retires the runtime exactly once');
        assert.equal(transport.disconnectCalls, 1);
    } finally {
        controller.dispose();
        resetWorldState();
    }
}

function resetWorldState(): void {
    worldStateStore.clear('world-transport-controller-test');
    worldLifecycleStore.reset('world-transport-controller-test');
}

function createController(isRuntimeReady: () => boolean = () => false) {
    const transport = new FakeTransport();
    const engagement = new EngagementService({ now: () => 1000 });
    const controller = new WorldTransportController({
        transport: transport as any,
        engagement,
        isRuntimeReady,
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
        assert.deepEqual(teardownReasons, ['partial-bootstrap-disconnect']);
    } finally {
        controller.dispose();
        resetWorldState();
    }
}

async function runActiveWorldRecoveryTests() {
    resetWorldState();
    worldStateStore.seed({
        world: { id: 'world-1', title: 'World One' },
        system: { id: 'shadowdark' },
    } as any);
    worldLifecycleStore.setState('active', 'test-ready');
    const { controller, transport, engagement } = createController(() => true);
    engagement.setActiveBrowserCount(1);
    const teardownReasons: string[] = [];
    transport.on('foundry:runtimeTeardown', (event: { reason: string }) => teardownReasons.push(event.reason));

    try {
        transport.emit('foundry:transportDisconnected', { reason: 'transport close' });
        assert.equal(worldLifecycleStore.getState(), 'offline');
        assert.equal(transport.connectCalls, 1, 'controller owns one replacement connection');
        assert.deepEqual(teardownReasons, [], 'transient close preserves the ready runtime');
        assert.equal(worldStateStore.getCurrentWorldId(), 'world-1');

        transport.emit('foundry:setupDetected', { pageTitle: 'Setup' });
        assert.equal(worldLifecycleStore.getState(), 'offline');
        assert.deepEqual(teardownReasons, [], 'one setup report cannot retire sessions');
        transport.emit('foundry:setupDetected', { pageTitle: 'Setup' });
        assert.equal(worldLifecycleStore.getState(), 'setup');
        assert.deepEqual(teardownReasons, ['confirmed-world-setup']);
    } finally {
        controller.dispose();
        resetWorldState();
    }
}

async function runRecoveryFailureRetryTest() {
    resetWorldState();
    worldLifecycleStore.setState('active', 'test-ready');
    const { controller, transport } = createController(() => true);
    try {
        controller.retryAfterRecoveryFailure();
        assert.equal(worldLifecycleStore.getState(), 'offline');
        assert.equal(transport.disconnectCalls, 1);
        assert.ok((controller as any).retryTimer, 'failed reconciliation schedules another connection');
    } finally {
        controller.dispose();
        resetWorldState();
    }
}

async function runProgressReconnectTests() {
    resetWorldState();
    const { controller, transport } = createController();

    try {
        transport.isConnected = true;
        transport.emit('foundry:progress', {
            data: { action: 'launchWorld', step: 'complete' },
        });

        assert.equal(
            transport.disconnectCalls,
            1,
            'launch completion disconnects the still-connected Setup transport',
        );
        assert.equal(
            transport.connectCalls,
            1,
            'launch completion starts a fresh world connection flow',
        );
    } finally {
        controller.dispose();
        resetWorldState();
    }
}

async function runClosedWorldMonitoringTests() {
    resetWorldState();
    const { controller, transport } = createController();

    try {
        transport.emit('foundry:worldTitleDetected', { pageTitle: 'world-old' });
        transport.emit('foundry:worldDiscovered', {
            world: { id: 'world-old', title: 'Old World' },
            userCount: 1,
        });
        transport.emit('foundry:serviceAccountMissing', {
            username: 'service-user',
            worldTitle: 'Old World',
            availableUsers: ['Gamemaster (role: 4)'],
        });

        assert.equal(worldLifecycleStore.getState(), 'closed');
        assert.ok((controller as any).heartbeatTimer, 'closed state keeps passive monitoring active');

        // Returning the known-bad world must not retry its login/bootstrap loop.
        controller.stopHeartbeat();
        transport.statusResponse = {
            csrfToken: null,
            isSetupMatch: false,
            pageTitle: 'world-old',
        };
        await (controller as any).runHeartbeat();
        assert.equal(transport.connectCalls, 0);

        // Foundry returning to setup is detected even though user sessions remain blocked.
        controller.stopHeartbeat();
        transport.statusResponse = {
            csrfToken: null,
            isSetupMatch: true,
            pageTitle: 'Setup',
        };
        await (controller as any).runHeartbeat();
        assert.equal(worldLifecycleStore.getState(), 'setup');
        assert.ok((controller as any).retryTimer, 'confirmed setup schedules a bounded retry');

        // Setup monitoring then detects and probes a newly started world.
        controller.stopHeartbeat();
        transport.statusResponse = {
            csrfToken: null,
            isSetupMatch: false,
            pageTitle: 'world-new',
        };
        await (controller as any).runHeartbeat();
        assert.equal(transport.connectCalls, 1);
    } finally {
        controller.dispose();
        resetWorldState();
    }
}

export async function run() {
    await runWorldControlTests();
    await runNativeShutdownRedirectTest();
    await runTransportFactTests();
    await runActiveWorldRecoveryTests();
    await runRecoveryFailureRetryTest();
    await runProgressReconnectTests();
    await runClosedWorldMonitoringTests();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('world-transport-controller.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
