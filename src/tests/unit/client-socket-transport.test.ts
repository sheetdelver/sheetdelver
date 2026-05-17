import { strict as assert } from 'node:assert';
import { ClientSocket } from '@core/foundry/sockets/ClientSocket';
import { systemService } from '@core/system/SystemService';

async function runClientSocketTransportTests() {
    const client = new ClientSocket({ url: 'http://foundry.example', username: 'player' });
    const originalGetSystemClient = (systemService as any).getSystemClient;
    let fallbackCalls = 0;

    try {
        (systemService as any).getSystemClient = () => {
            fallbackCalls += 1;
            return {
                dispatchDocument: async () => {
                    throw new Error('CoreSocket fallback should not be used');
                },
            };
        };

        await assert.rejects(
            () => client.dispatchDocument('Actor', 'update', { updates: [{ _id: 'a1', name: 'Nope' }] }),
            /user socket is not connected/,
        );
        assert.equal(fallbackCalls, 0);
    } finally {
        (systemService as any).getSystemClient = originalGetSystemClient;
    }
}

export async function run() {
    await runClientSocketTransportTests();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('client-socket-transport.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
