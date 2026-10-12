import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'socket.io-client';
import { CoreSocket } from '@server/core/foundry/sockets/CoreSocket';
import { SocketBase } from '@server/core/foundry/sockets/SocketBase';
import { LOG_LEVEL, logger } from '@shared/utils/logger';

class TestStatusSocket extends SocketBase {
    async connect(): Promise<void> { /* handshake fixture only */ }
    check() { return this.performHandshake(this.url); }
    checkGuarded(canCommit: () => boolean) {
        return this.performHandshake('http://foundry.test', { canCommit });
    }
    login() { return this.performLogin('http://foundry.test', 'test-user', null); }
    setStatusTimeoutForTest(ms: number) { this.statusTimeoutMs = ms; }
}

class FakeProbeSocket extends EventEmitter {
    disconnected = false;
    worldStatus = true;
    override emit(event: string, ...args: any[]): boolean {
        if (event === 'getJoinData' || event === 'world') {
            setImmediate(() => (args[0] as (result: null) => void)(null));
            return true;
        }
        if (event === 'getWorldStatus') {
            setImmediate(() => (args[0] as (result: boolean) => void)(this.worldStatus));
            return true;
        }
        return super.emit(event, ...args);
    }
    connectNow() { super.emit('connect'); }
    disconnect() { this.disconnected = true; }
}

class TestProbeSocket extends TestStatusSocket {
    guest = new FakeProbeSocket();
    protected override createGuestProbeSocket(): Socket {
        setImmediate(() => this.guest.connectNow());
        return this.guest as unknown as Socket;
    }
    probe() { return this.probeWorldState(this.url); }
}

async function runBoundedStatusAndProbeFallback(): Promise<void> {
    const server = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"active":');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address() as AddressInfo;
        const socket = new TestStatusSocket({ url: `http://127.0.0.1:${address.port}` });
        socket.setStatusTimeoutForTest(80);
        await assert.rejects(socket.check(), /abort|timeout/i,
            'the status deadline covers a stalled response body');
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }

    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response(JSON.stringify({ active: false, world: 'not-active' }), { status: 200 });
        const probe = new TestProbeSocket({ url: 'http://foundry.test' });
        const result = await probe.probe();
        assert.equal(result.status, 'active', 'the final socket acknowledgement is awaited');
        assert.equal(probe.guest.disconnected, true);
        assert.equal(Array.isArray(result.users), false, 'status-only evidence is incomplete discovery');
        const inactive = new TestProbeSocket({ url: 'http://foundry.test' });
        inactive.guest.worldStatus = false;
        assert.equal(await inactive.probe(), null, 'inactive HTTP and socket status cannot discover a world');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

class TestRecoveringCoreSocket extends CoreSocket {
    seedCookie(cookie: string) { this.hydrateCookieHeader(cookie); }
}

async function runCookieSpecificStatusRecovery(): Promise<void> {
    const originalFetch = globalThis.fetch;
    const socket = new TestRecoveringCoreSocket({ url: 'http://foundry.test' });
    socket.seedCookie('session=stale');
    const sentCookies: Array<string | null> = [];
    try {
        globalThis.fetch = async (_url, options) => {
            const cookie = new Headers(options?.headers).get('cookie');
            sentCookies.push(cookie);
            if (cookie) return new Response('Internal Server Error', { status: 500 });
            return new Response(JSON.stringify({ active: true, world: 'recovered' }), {
                status: 200,
                headers: { 'Set-Cookie': 'session=fresh; Path=/' },
            });
        };
        assert.equal((await socket.checkStatus()).pageTitle, 'recovered');
        assert.deepEqual(sentCookies, ['session=stale', null]);
        assert.equal(socket.getSessionCookie(), 'session=fresh');
    } finally {
        globalThis.fetch = originalFetch;
    }

    const upstream = new TestRecoveringCoreSocket({ url: 'http://foundry.test' });
    upstream.seedCookie('session=retain');
    let requests = 0;
    try {
        globalThis.fetch = async () => {
            requests += 1;
            return new Response('Internal Server Error', { status: 500 });
        };
        await assert.rejects(upstream.checkStatus(), /status 500/);
        assert.equal(upstream.getSessionCookie(), 'session=retain', 'ambiguous 500 preserves the session');
        assert.equal(requests, 2, 'one bounded anonymous diagnostic follows the first 500');
        await assert.rejects(upstream.checkStatus(), /status 500/);
        assert.equal(requests, 3, 'cooldown prevents another anonymous probe');
    } finally {
        globalThis.fetch = originalFetch;
    }
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

async function runStaleStatusAndLoginDiagnostics(): Promise<void> {
    const originalFetch = globalThis.fetch;
    const socket = new TestStatusSocket({ url: 'http://foundry.test' });
    let resolveStatus!: (response: Response) => void;
    let current = true;
    const records: string[] = [];
    const originalDebug = console.debug;
    const originalError = console.error;
    try {
        globalThis.fetch = async () => new Promise<Response>((resolve) => { resolveStatus = resolve; });
        const stale = socket.checkGuarded(() => current);
        current = false;
        resolveStatus(new Response(JSON.stringify({ active: true, world: 'stale-world' }), {
            status: 200, headers: { 'Set-Cookie': 'session=stale-secret; Path=/' },
        }));
        await assert.rejects(stale, /superseded/);
        assert.equal(socket.getSessionCookie(), null, 'late status cannot change Core cookies');

        logger.setLevel(LOG_LEVEL.DEBUG);
        logger.setFileSink((_level, message, args) => records.push(`${message} ${args.join(' ')}`));
        console.debug = (...args) => { records.push(args.join(' ')); };
        console.error = (...args) => { records.push(args.join(' ')); };
        globalThis.fetch = async () => new Response('', {
            status: 200, headers: { 'Set-Cookie': 'session=login-secret; Path=/' },
        });
        await socket.login();
        assert.equal(socket.getSessionCookie(), 'session=login-secret');
        globalThis.fetch = async () => new Response('login-error-secret', { status: 401 });
        await assert.rejects(socket.login(), /^Error: Login failed with status 401$/);
        assert.equal(records.join(' ').includes('login-secret'), false);
        assert.equal(records.join(' ').includes('login-error-secret'), false);
    } finally {
        globalThis.fetch = originalFetch;
        logger.setFileSink(null);
        logger.setLevel(LOG_LEVEL.INFO);
        console.debug = originalDebug;
        console.error = originalError;
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
    pendingWorldStatus: ((status: unknown) => void) | null = null;

    override emit(event: string, ...args: any[]): boolean {
        if (event === 'getWorldStatus') {
            if (this.worldStatus === 'defer') this.pendingWorldStatus = args[0] as (status: unknown) => void;
            else (args[0] as (status: unknown) => void)(this.worldStatus);
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
    probeResult: any = { world: { id: 'world-one', title: 'World One' }, users: [] };

    constructor(config: { url: string; username?: string }) {
        super(config);
    }
    setSocketTimeoutForTest(ms: number) { this.mainSocketTimeoutMs = ms; }

    protected override async performHandshake() {
        return { csrfToken: null, isSetupMatch: false, pageTitle: 'world-one' };
    }

    protected override async probeWorldState() {
        return this.probeResult;
    }

    protected override async performLogin(): Promise<void> { /* isolated transport fixture */ }

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
    await runBoundedStatusAndProbeFallback();
    await runHandshakeClassification();
    await runStaleStatusAndLoginDiagnostics();
    await runCookieSpecificStatusRecovery();
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

    const incomplete = new TestCoreSocket({ url: 'http://foundry.test', username: 'service-user' });
    incomplete.probeResult = { world: { id: 'world-one', title: 'World One' }, status: 'active' };
    let missingAccount = 0;
    let incompleteFailure = 0;
    let discoveredWorlds = 0;
    incomplete.on('foundry:serviceAccountMissing', () => { missingAccount += 1; });
    incomplete.on('foundry:connectionFailed', () => { incompleteFailure += 1; });
    incomplete.on('foundry:worldDiscovered', () => { discoveredWorlds += 1; });
    await incomplete.connect();
    assert.equal(missingAccount, 0, 'API-only discovery does not prove an account is absent');
    assert.equal(incompleteFailure, 1);
    assert.equal(discoveredWorlds, 0, 'incomplete discovery does not seed a provisional world');
    incomplete.probeResult = { world: { id: 'world-one', title: 'World One' }, users: [{ name: 'other' }] };
    await incomplete.connect();
    assert.equal(missingAccount, 0, 'malformed user entries are not authoritative absence');
    incomplete.probeResult = {
        world: { id: 'world-one', title: 'World One' },
        users: [{ name: 'service-user', _id: 'user-one' }],
    };
    const recovered = incomplete.connect();
    const recoveredSocket = await nextSocket(incomplete, 1);
    recoveredSocket.triggerConnect();
    await recovered;
    assert.equal(incomplete.isConnected, true, 'the same world can recover on a later complete probe');
    incomplete.disconnect();
    incomplete.probeResult = { world: { id: 'world-one', title: 'World One' }, users: [] };
    await incomplete.connect();
    assert.equal(missingAccount, 1, 'a complete empty user list still reports a genuinely missing account');
    incomplete.disconnect();

    const late = new TestCoreSocket({ url: 'http://foundry.test' });
    late.setSocketTimeoutForTest(30);
    let lateReady = 0;
    late.on('foundry:worldActive', () => { lateReady += 1; });
    const timedOut = late.connect();
    const timedOutSocket = await nextSocket(late, 1);
    timedOutSocket.worldStatus = 'defer';
    timedOutSocket.triggerConnect();
    await timedOut;
    assert.equal(timedOutSocket.disconnectCalls, 1, 'timeout retires its socket immediately');
    timedOutSocket.pendingWorldStatus?.(true);
    timedOutSocket.triggerConnect();
    assert.equal(lateReady, 0, 'late callbacks cannot activate a failed attempt');
    const replacement = late.connect();
    const replacementSocket = await nextSocket(late, 2);
    replacementSocket.triggerConnect();
    await replacement;
    assert.equal(lateReady, 1);
    late.disconnect();

    const erroredTransport = new TestCoreSocket({ url: 'http://foundry.test' });
    const errored = erroredTransport.connect();
    const erroredSocket = await nextSocket(erroredTransport, 1);
    erroredSocket.emit('connect_error', new Error('isolated transport failure'));
    await errored;
    assert.equal(erroredSocket.disconnectCalls, 1, 'connect_error retires its socket before retry');
    erroredTransport.disconnect();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().then(() => console.log('core-socket-recovery.test.ts passed'))
        .catch(error => { console.error(error); process.exit(1); });
}
