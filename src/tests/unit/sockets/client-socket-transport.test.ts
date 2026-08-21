import { strict as assert } from 'node:assert';
import { ClientSocket } from '@core/foundry/sockets/ClientSocket';
import { systemService } from '@server/services/world';

// Expose the shared protected authentication steps without opening a real socket.
class LoginContractClientSocket extends ClientSocket {
    public lastLoginPayload: Record<string, unknown> | null = null;

    async performVersionedLogin(foundryVersion: string, userId: string): Promise<void> {
        const originalFetch = globalThis.fetch;
        const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];

        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = input.toString();
            requests.push({
                url,
                body: init?.body ? JSON.parse(String(init.body)) : null,
            });

            if (url.endsWith('/api/status')) {
                return Response.json({ active: true, version: foundryVersion, world: 'test-world' });
            }

            return new Response('{}', {
                status: 200,
                headers: { 'set-cookie': 'session=test-session' },
            });
        }) as typeof fetch;

        try {
            const baseUrl = this.getBaseUrl();
            const { csrfToken } = await this.performHandshake(baseUrl);
            await this.performLogin(baseUrl, userId, csrfToken);
            const loginRequest = requests.find((request) => request.url.endsWith('/join'));
            assert.ok(loginRequest, 'Expected a POST request to Foundry /join');
            this.lastLoginPayload = loginRequest.body;
        } finally {
            globalThis.fetch = originalFetch;
        }
    }
}

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

async function runVersionedLoginContractTests() {
    const v13Client = new LoginContractClientSocket({
        url: 'http://foundry.example',
        username: 'player',
        password: 'secret',
    });
    await v13Client.performVersionedLogin('13.351', 'user-13');
    assert.deepEqual(v13Client.lastLoginPayload, {
        userid: 'user-13',
        password: 'secret',
        action: 'join',
    });

    const v14LegacyClient = new LoginContractClientSocket({
        url: 'http://foundry.example',
        username: 'player',
        password: 'secret',
    });
    await v14LegacyClient.performVersionedLogin('14.365', 'user-14-legacy');
    assert.deepEqual(v14LegacyClient.lastLoginPayload, {
        userid: 'user-14-legacy',
        password: 'secret',
        action: 'join',
    });

    for (const version of ['14.366', '14.367']) {
        const v14Client = new LoginContractClientSocket({
            url: 'http://foundry.example',
            username: 'player',
            password: 'secret',
        });
        await v14Client.performVersionedLogin(version, `user-${version}`);
        assert.deepEqual(v14Client.lastLoginPayload, {
            password: 'secret',
            action: 'join',
            username: 'player',
            userId: `user-${version}`,
        });
    }
}

export async function run() {
    await runClientSocketTransportTests();
    await runRestoredCredentialConnectIsTransportOnly();
    await runVersionedLoginContractTests();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('client-socket-transport.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
