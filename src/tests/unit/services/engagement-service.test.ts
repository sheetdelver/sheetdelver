import { strict as assert } from 'node:assert';
import { EngagementService } from '@server/services/world';
import type { WorldLifecycleState } from '@server/core/world/WorldLifecycleStore';

function createClock(initial: number) {
    let value = initial;

    return {
        now: () => value,
        set: (next: number) => {
            value = next;
        },
    };
}

function runReturnToEngagementTest() {
    const service = new EngagementService({ now: () => 1000 });
    const calls: string[] = [];
    const reconnectInputs = { lifecycleState: 'offline' as WorldLifecycleState, isConnecting: false };

    service.setTransportCallbacks({
        resetRetryBackoff: () => {
            calls.push('reset-backoff');
        },
        startHeartbeat: (immediate = false) => {
            calls.push(`heartbeat:${immediate}`);
        },
        getReconnectInputs: () => reconnectInputs,
        reconnect: () => {
            calls.push('reconnect');
        },
    });

    const update = service.setActiveBrowserCount(1);
    assert.deepEqual(update, {
        previousCount: 0,
        browserCount: 1,
        becameEngaged: true,
    });
    assert.deepEqual(calls, ['reset-backoff', 'heartbeat:true', 'reconnect']);

    calls.length = 0;
    service.setActiveBrowserCount(2);
    assert.deepEqual(calls, []);
}

function runNoReconnectWhenAlreadyActiveTest() {
    const service = new EngagementService({ now: () => 1000 });
    const calls: string[] = [];
    let lifecycleState: WorldLifecycleState = 'active';
    let isConnecting = false;

    service.setTransportCallbacks({
        resetRetryBackoff: () => {
            calls.push('reset-backoff');
        },
        startHeartbeat: (immediate = false) => {
            calls.push(`heartbeat:${immediate}`);
        },
        getReconnectInputs: () => ({ lifecycleState, isConnecting }),
        reconnect: () => {
            calls.push('reconnect');
        },
    });

    service.setActiveBrowserCount(1);
    assert.deepEqual(calls, ['reset-backoff', 'heartbeat:true']);

    calls.length = 0;
    service.setActiveBrowserCount(0);
    lifecycleState = 'setup';
    isConnecting = true;
    service.setActiveBrowserCount(1);
    assert.deepEqual(calls, ['reset-backoff', 'heartbeat:true']);
}

function runHeartbeatCadenceTest() {
    const clock = createClock(0);
    const service = new EngagementService({ now: clock.now });

    assert.equal(service.getNextHeartbeatDelayMs(), 30000);

    service.setActiveBrowserCount(1);
    assert.equal(service.getNextHeartbeatDelayMs(), 5000);

    service.setActiveBrowserCount(0);
    clock.set(600001);
    assert.equal(service.getNextHeartbeatDelayMs(), 60000);

    clock.set(1800001);
    assert.equal(service.getNextHeartbeatDelayMs(), 120000);
}

async function runPauseAndRunPolicyTest() {
    const service = new EngagementService({ now: () => 1000 });
    const activePolicy = {
        isConnected: true,
        isConnecting: false,
        lifecycleState: 'active' as WorldLifecycleState,
    };

    assert.equal(service.shouldRunHeartbeat(activePolicy), true);
    assert.equal(service.shouldRunHeartbeat({ ...activePolicy, isConnected: false }), false);
    assert.equal(service.shouldRunHeartbeat({ ...activePolicy, lifecycleState: 'offline', isConnected: false }), true);
    assert.equal(service.shouldRunHeartbeat({ ...activePolicy, lifecycleState: 'startup' }), false);
    assert.equal(service.shouldRunHeartbeat({ ...activePolicy, isConnecting: true }), false);

    const result = await service.withHeartbeatPaused(async () => {
        assert.equal(service.isHeartbeatSuspended(), true);
        assert.equal(service.shouldRunHeartbeat(activePolicy), false);
        return 'paused-result';
    });

    assert.equal(result, 'paused-result');
    assert.equal(service.isHeartbeatSuspended(), false);
    assert.equal(service.shouldRunHeartbeat(activePolicy), true);
}

function runDisconnectPolicyTest() {
    const service = new EngagementService({ now: () => 1000 });

    assert.equal(service.shouldReconnectAfterUnexpectedDisconnect('transport close'), false);
    service.setActiveBrowserCount(1);
    assert.equal(service.shouldReconnectAfterUnexpectedDisconnect('transport close'), true);
    assert.equal(service.shouldReconnectAfterUnexpectedDisconnect('io client disconnect'), false);
}

export async function run() {
    runReturnToEngagementTest();
    runNoReconnectWhenAlreadyActiveTest();
    runHeartbeatCadenceTest();
    await runPauseAndRunPolicyTest();
    runDisconnectPolicyTest();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('engagement-service.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
