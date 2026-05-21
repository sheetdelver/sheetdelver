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

async function runRestoredCredentialConnectIsTransportOnly() {
    class TestClientSocket extends ClientSocket {
        public connectCalls = 0;

        async connect(): Promise<void> {
            this.connectCalls += 1;
            this.isSocketConnected = true;
        }
    }

    const client = new TestClientSocket({ url: 'http://foundry.example', username: 'player' });

    await client.connectWithRestoredCredential({
        userId: 'user-1',
        cookie: 'session=abc123; foundry=xyz',
    });

    assert.equal(client.connectCalls, 1);
    assert.equal(client.userId, 'user-1');
    assert.equal(client.isExplicitSession, true);
    assert.equal(client.getSessionCookie(), 'session=abc123; foundry=xyz');
}

export async function run() {
    await runClientSocketTransportTests();
    await runRestoredCredentialConnectIsTransportOnly();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('client-socket-transport.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
