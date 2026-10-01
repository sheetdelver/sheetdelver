import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import type { Socket } from 'socket.io-client';
import { CoreSocket } from '@server/core/foundry/sockets/CoreSocket';
import { SocketBase } from '@server/core/foundry/sockets/SocketBase';

class TestStatusSocket extends SocketBase {
    async connect(): Promise<void> { /* handshake fixture only */ }
    check() { return this.performHandshake('http://foundry.test'); }
}

async function runHandshakeClassification(): Promise<void> {
    const originalFetch = globalThis.fetch;
    const socket = new TestStatusSocket({ url: 'http://foundry.test' });
    try {
        globalThis.fetch = async () => new Response(JSON.stringify({ active: true }), { status: 200 });
        assert.equal((await socket.check()).isSetupMatch, false,
            'an active response without a title is not setup');
        globalThis.fetch = async () => new Response(JSON.stringify({ world: 'world-one' }), { status: 200 });
        await assert.rejects(socket.check(), /active boolean/,
            'a partial status cannot revoke sessions');
        globalThis.fetch = async () => new Response(JSON.stringify({ active: false }), { status: 200 });
        assert.equal((await socket.check()).isSetupMatch, true);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function runShutdownRedirectClassification(): Promise<void> {
    const originalFetch = globalThis.fetch;
    const socket = new CoreSocket({ url: 'http://foundry.test' });
    let statusReads = 0;
    try {
        globalThis.fetch = async (_url, options) => {
            if (options?.method === 'POST') {
                return new Response('Found. Redirecting to /setup', {
                    status: 302, headers: { Location: '/setup' },
                });
            }
            statusReads += 1;
            return new Response(JSON.stringify({ active: false }), { status: 200 });
        };
        assert.deepEqual(await socket.postSetupAction({ shutdown: true }), { shutdown: true });
        assert.equal(statusReads, 1, 'redirect success requires affirmative setup status');

        globalThis.fetch = async () => new Response('Found. Redirecting to /join', {
            status: 302, headers: { Location: '/join' },
        });
        await assert.rejects(socket.postSetupAction({ shutdown: true }), /status 302/,
            'unrelated redirect is not shutdown confirmation');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

class FakeSocket extends EventEmitter {
    connected = false;
    io = { engine: { transport: { name: 'websocket' } } };
    disconnectCalls = 0;
    worldStatus: unknown = true;

    override emit(event: string, ...args: any[]): boolean {
        if (event === 'getWorldStatus') {
            (args[0] as (status: unknown) => void)(this.worldStatus);
            return true;
        }
        return super.emit(event, ...args);
    }

    triggerConnect(): void {
        this.connected = true;
        super.emit('connect');
    }

    triggerDisconnect(reason = 'transport close'): void {
        this.connected = false;
        super.emit('disconnect', reason, { message: 'websocket connection closed' });
    }

    disconnect(): void {
        this.disconnectCalls += 1;
        this.connected = false;
    }
}

class TestCoreSocket extends CoreSocket {
    sockets: FakeSocket[] = [];
    options: Array<Record<string, unknown>> = [];

    protected override async performHandshake() {
        return { csrfToken: null, isSetupMatch: false, pageTitle: 'world-one' };
    }

    protected override async probeWorldState() {
        return { world: { id: 'world-one', title: 'World One' }, users: [] };
    }

    protected override createMainSocket(_baseUrl: string, options: Record<string, unknown>): Socket {
        this.options.push(options);
        const socket = new FakeSocket();
        this.sockets.push(socket);
        return socket as unknown as Socket;
    }
}

async function nextSocket(socket: TestCoreSocket, count: number): Promise<FakeSocket> {
    for (let attempt = 0; attempt < 10 && socket.sockets.length < count; attempt++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(socket.sockets.length, count);
    return socket.sockets[count - 1];
}

export async function run(): Promise<void> {
    await runHandshakeClassification();
    await runShutdownRedirectClassification();
    const transport = new TestCoreSocket({ url: 'http://foundry.test' });
    let connected = 0;
    let disconnected = 0;
    transport.on('connect', () => { connected += 1; });
    transport.on('foundry:transportDisconnected', () => { disconnected += 1; });

    const firstAttempt = transport.connect();
    const first = await nextSocket(transport, 1);
    assert.equal(transport.options[0].reconnection, false, 'controller is sole Core reconnect owner');
    first.triggerConnect();
    await firstAttempt;
    assert.equal(connected, 1);
    first.triggerDisconnect();
    assert.equal(disconnected, 1);

    const secondAttempt = transport.connect();
    const second = await nextSocket(transport, 2);
    assert.equal(first.disconnectCalls, 1, 'replacement retires the old socket');
    first.triggerConnect();
    first.triggerDisconnect();
    assert.equal(connected, 1, 'obsolete socket callbacks cannot report a new connection');
    assert.equal(disconnected, 1, 'obsolete socket callbacks cannot report another close');
    second.triggerConnect();
    await secondAttempt;
    assert.equal(connected, 2);

    second.triggerDisconnect();
    const thirdAttempt = transport.connect();
    const third = await nextSocket(transport, 3);
    third.worldStatus = undefined;
    let inactive = 0;
    let failed = 0;
    transport.on('foundry:worldInactive', () => { inactive += 1; });
    transport.on('foundry:connectionFailed', () => { failed += 1; });
    third.triggerConnect();
    await thirdAttempt;
    assert.equal(inactive, 0, 'indeterminate acknowledgement is not setup evidence');
    assert.equal(failed, 1);
    assert.equal(transport.isConnected, false);
    transport.disconnect();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().then(() => console.log('core-socket-recovery.test.ts passed'))
        .catch(error => { console.error(error); process.exit(1); });
}
