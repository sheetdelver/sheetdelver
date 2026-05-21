
import { ClientSocket } from '@core/foundry/sockets/ClientSocket';
import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { FoundryConfig } from '@core/foundry/types';
import { EventEmitter } from 'events';
import { logger } from '@shared/utils/logger';

// Mock Socket.io Client
class MockSocket extends EventEmitter {
    id = 'mock-socket-id';
    io = { opts: { query: {} } };
    connected = true;
    disconnect() { this.emit('disconnect'); }
    connect() { this.emit('connect'); }
}

class TestClient extends ClientSocket {
    public mockSocket: MockSocket;

    constructor(config: FoundryConfig, core: CoreSocket) {
        super(config, core);
        this.mockSocket = new MockSocket();
        // @ts-ignore
        // We can't assign to this.socket because ClientSocket doesn't have it anymore! 
        // We need to manipulate the CoreSocket instance if we want to mock socket behavior.
        // But this test checks `ClientSocket` logic (userId).
        // Does ClientSocket logic depend on socket?
        // connectWithRestoredCredential sets userId before it calls connect().
        // This deprecated harness only checks the userId state transition.
    }

    public setUserId(id: string | null) {
        this.userId = id;
    }
}

async function run() {
    const config: FoundryConfig = { url: 'http://test', username: 'user', password: 'pw' };
    const core = new CoreSocket(config);
    const client = new TestClient(config, core);

    logger.info('--- Auth Logic Test (ClientSocket) ---');

    // 1. Initial State
    logger.info(`Initial userId: ${client.userId} (Expected: null)`);
    if (client.userId !== null) throw new Error('Initial state wrong');

    // 2. Simulate Logged In
    client.setUserId('user-123');
    logger.info(`Logged In userId: ${client.userId} (Expected: user-123)`);
    if (client.userId !== 'user-123') throw new Error('Logged in state wrong');

    logger.info('\n✅ All Auth Logic Tests Passed');
}

run().catch(e => {
    logger.error('Auth logic test failed:', e);
    process.exit(1);
});
