import { strict as assert } from 'node:assert';
import { ClientSocket } from '@core/foundry/sockets/ClientSocket';
import { FOUNDRY_LOGOUT_TIMEOUT_MS } from '@core/foundry/sockets/SocketBase';
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

class DispatchContractClientSocket extends ClientSocket {
    public response: unknown = {
        operation: { updates: [{ _id: 'actor-1', name: 'Updated' }] },
        result: [{ _id: 'actor-1', name: 'Updated' }],
    };

    public constructor() {
        super({ url: 'http://foundry.example', username: 'player' });
        this.socket = {} as never;
        this.isSocketConnected = true;
    }

    public async emitSocketEvent<T>(): Promise<T> {
        return this.response as T;
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

async function runDispatchAcknowledgementContract() {
    const client = new DispatchContractClientSocket();
    const confirmations: unknown[] = [];
    client.on('foundry:documentDispatchConfirmed', event => confirmations.push(event));

    const response = await client.dispatchDocument(
        'Actor',
        'update',
        { updates: [{ _id: 'actor-1', name: 'Updated' }] },
    );

    assert.equal(response, client.response);
    assert.deepEqual(confirmations, [{
        response: client.response,
        fallback: {
            type: 'Actor',
            action: 'update',
            operation: { updates: [{ _id: 'actor-1', name: 'Updated' }] },
        },
    }]);
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

async function runLogoutUsesBoundedRequest() {
    const originalFetch = globalThis.fetch;
    const requestSignals: Array<AbortSignal | null> = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        requestSignals.push(init?.signal ?? null);
        return new Response('{}', { status: 200 });
    }) as typeof fetch;

    try {
        const client = new ClientSocket({ url: 'http://foundry.example', username: 'player' });
        await client.logout();

        // A concrete bound documents the operator-visible maximum wait and
        // verifies the transport request cannot remain pending indefinitely.
        assert.equal(FOUNDRY_LOGOUT_TIMEOUT_MS, 5_000);
        const requestSignal = requestSignals[0];
        assert.ok(requestSignal instanceof AbortSignal);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

export async function run() {
    await runClientSocketTransportTests();
    await runRestoredCredentialConnectIsTransportOnly();
    await runDispatchAcknowledgementContract();
    await runVersionedLoginContractTests();
    await runLogoutUsesBoundedRequest();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('client-socket-transport.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
