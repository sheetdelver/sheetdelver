import { strict as assert } from 'node:assert';
import { createSystemStatusBroadcaster } from '@server/realtime/SystemStatusBroadcaster';
import { systemService } from '@server/services/world';
import type { SystemStatusPayload } from '@shared/contracts/status';

type ListenerMap = Record<string, Array<(...args: unknown[]) => void>>;

async function runBroadcasterTests() {
    const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
    const io = {
        to: (room: string) => ({
            emit: (event: string, payload: unknown) => {
                emitted.push({ room, event, payload });
            },
        }),
    };

    let payloadCounter = 0;
    let lifecycleStatus: SystemStatusPayload['system']['status'] = 'active';
    const broadcaster = createSystemStatusBroadcaster({
        io: io as any,
        getSystemStatusPayload: async () => ({
            connected: lifecycleStatus === 'active',
            worldId: 'w1',
            initialized: lifecycleStatus === 'active',
            isConfigured: true,
            foundryCompatibility: null,
            users: [{ _id: 'private-id', name: 'Player', role: 1, active: false }],
            system: {
                id: 'shadowdark',
                worldTitle: 'Test',
                worldDescription: 'private',
                status: lifecycleStatus,
                actorSyncToken: String(++payloadCounter),
            },
            url: 'http://localhost:30000',
            appVersion: '0.0.0-test',
            debug: { enabled: false, level: 1 },
        } as SystemStatusPayload),
    });

    await broadcaster.broadcastSystemStatus();
    assert.equal(emitted.length, 2);
    assert.deepEqual(emitted.map((entry) => entry.room), ['authenticated', 'status:public']);
    const guestInitial = emitted.find((entry) => entry.room === 'status:public')?.payload as Record<string, unknown>;
    assert.equal(Object.hasOwn(guestInitial, 'debug'), false);
    assert.equal(JSON.stringify(guestInitial).includes('private-id'), false);

    const originalOn = (systemService as any).on;
    const originalOff = (systemService as any).off;

    const listeners: ListenerMap = {};
    const offCalls: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

    try {
        (systemService as any).on = (event: string, handler: (...args: unknown[]) => void) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(handler);
        };
        (systemService as any).off = (event: string, handler: (...args: unknown[]) => void) => {
            offCalls.push({ event, handler });
        };

        const registration = broadcaster.registerLifecycleBroadcasts();

        assert.ok(listeners['world:connected']?.length === 1);
        assert.ok(listeners['world:disconnected']?.length === 1);
        assert.ok(listeners['world:ready']?.length === 1);
        assert.ok(listeners['system:status-update']?.length === 1);

        listeners['world:connected'][0]({ state: 'active' });
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Both audiences receive lifecycle progression, but through distinct DTOs.
        const lifecycleEmissions: SystemStatusPayload[] = [];
        for (const status of ['closed', 'setup', 'startup', 'active'] as const) {
            lifecycleStatus = status;
            const previousEmissionCount: number = emitted.length;
            listeners['system:status-update'][0]();
            await new Promise((resolve) => setTimeout(resolve, 0));
            assert.equal(emitted.length, previousEmissionCount + 2);
            const authenticated = emitted
                .slice(previousEmissionCount)
                .find((entry) => entry.room === 'authenticated');
            assert.equal(authenticated?.event, 'systemStatus');
            lifecycleEmissions.push(authenticated?.payload as SystemStatusPayload);
        }
        assert.deepEqual(
            lifecycleEmissions.map((payload) => payload.system.status),
            ['closed', 'setup', 'startup', 'active'],
        );
        assert.equal(lifecycleEmissions.at(-1)?.connected, true);

        registration.dispose();
        assert.equal(offCalls.length, 4);
    } finally {
        (systemService as any).on = originalOn;
        (systemService as any).off = originalOff;
    }

    const pollingInterval = broadcaster.startPolling(10);
    await new Promise((resolve) => setTimeout(resolve, 25));
    clearInterval(pollingInterval);
    assert.ok(emitted.length >= 3);
}

export async function run() {
    await runBroadcasterTests();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('realtime-broadcaster.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
