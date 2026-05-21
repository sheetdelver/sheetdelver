import { strict as assert } from 'node:assert';
import { createSystemStatusBroadcaster } from '@server/realtime/SystemStatusBroadcaster';
import { systemService } from '@core/system/SystemService';
import type { SystemStatusPayload } from '@shared/contracts/status';

type ListenerMap = Record<string, Array<(...args: unknown[]) => void>>;

async function runBroadcasterTests() {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const io = {
        emit: (event: string, payload: unknown) => {
            emitted.push({ event, payload });
        },
    };

    let payloadCounter = 0;
    const broadcaster = createSystemStatusBroadcaster({
        io: io as any,
        getSystemStatusPayload: async () => ({
            connected: true,
            worldId: 'w1',
            initialized: true,
            isConfigured: true,
            foundryCompatibility: null,
            users: [],
            system: { id: 'shadowdark', worldTitle: 'Test', status: 'active', actorSyncToken: String(++payloadCounter) },
            url: 'http://localhost:30000',
            appVersion: '0.0.0-test',
            debug: { enabled: false, level: 1 },
        } as SystemStatusPayload),
    });

    await broadcaster.broadcastSystemStatus();
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'systemStatus');

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
        listeners['system:status-update'][0]();
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.ok(emitted.length >= 3);

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
