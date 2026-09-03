import { strict as assert } from 'node:assert';
import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { FoundryEventIngress } from '@server/services/world/FoundryEventIngress';

/**
 * Per ADR-0021/0023, CoreSocket.dispatchDocumentSocket emits confirmed
 * world-scoped writes for FoundryEventIngress, but must not emit pack-scoped
 * reads into the world document ingress path.
 */
class FakeSocket {
    public connected = true;
}

class TestCoreSocket extends CoreSocket {
    public emitCalls: Array<{ event: string; payloads: unknown[] }> = [];
    public emitResponse: unknown = { result: [{ _id: 'doc-1', name: 'Synthetic Item' }] };

    public constructor() {
        super({ url: 'http://foundry.example', userId: 'gm', password: 'pw' } as any);
        // Inject a fake socket so dispatchDocumentSocket's connected check passes.
        (this as any).socket = new FakeSocket();
    }

    public async emitSocketEvent<T>(event: string, ...payloads: unknown[]): Promise<T> {
        this.emitCalls.push({ event, payloads });
        return this.emitResponse as T;
    }
}

async function runPackScopedDispatchSkipsWorldRouter() {
    const socket = new TestCoreSocket();
    const routerCalls: Array<{ type: string; action: string; operation?: unknown }> = [];
    const ingress = new FoundryEventIngress({
        routeDocument: (input) => {
            routerCalls.push({ type: input.type, action: input.action, operation: input.operation });
        },
    });
    const detachIngress = ingress.attach(socket);

    try {
        await socket.dispatchDocumentSocket('Item', 'get', { pack: 'dnd5e.items', index: true });
        assert.equal(routerCalls.length, 0, 'pack-scoped dispatch should not invoke modifyDocumentRouter');

        await socket.dispatchDocumentSocket('Item', 'update', { updates: [{ _id: 'doc-1' }] });
        assert.equal(routerCalls.length, 1, 'world-scoped dispatch should still invoke modifyDocumentRouter');
        assert.equal(routerCalls[0].type, 'Item');
        assert.equal(routerCalls[0].action, 'update');
    } finally {
        detachIngress();
    }
}

export async function run() {
    await runPackScopedDispatchSkipsWorldRouter();
    console.log('  - CoreSocket pack-scope guard: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('core-socket-pack-scope.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
