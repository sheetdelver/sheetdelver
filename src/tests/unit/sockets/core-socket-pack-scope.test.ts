import { strict as assert } from 'node:assert';
import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { FoundryEventIngress } from '@server/services/world/FoundryEventIngress';
import { PrimaryDocumentRepository } from '@server/core/documents/primary/base/PrimaryDocumentRepository';
import type { ModifyDocumentAction, PrimaryDocumentStore } from '@server/core/documents/primary/base/PrimaryDocumentStore';

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

async function runRepositorySkipsPackMirror() {
    const mirrored: Array<{ type: string; action: ModifyDocumentAction; result: unknown }> = [];
    const store = { applyModifyDocument: (type: string, action: ModifyDocumentAction, result: unknown) => {
        mirrored.push({ type, action, result });
    } } as PrimaryDocumentStore<{ _id: string }>;
    let response: any = { operation: { pack: null }, result: [{ _id: 'pack-actor' }] };
    const transport = { dispatchDocument: async () => response };
    class TestRepository extends PrimaryDocumentRepository<{ _id: string }> {
        public dispatch(type: string, action: ModifyDocumentAction, operation: Record<string, unknown>) {
            return this.dispatchDocument(type, action, operation);
        }
    }
    const repository = new TestRepository(transport, store);

    await repository.dispatch('Actor', 'get', { pack: 'synthetic.monsters', index: true });
    assert.equal(mirrored.length, 0,
        'route-scoped Repository must not mirror a pack read even when response pack is null');

    response = { operation: { pack: 'synthetic.monsters' }, result: [{ _id: 'pack-actor' }] };
    await repository.dispatch('Actor', 'create', { data: [{ name: 'Pack Actor' }] });
    assert.equal(mirrored.length, 0, 'pack mutation acknowledgements also stay out of world Stores');

    response = { result: [{ _id: 'world-actor' }] };
    await repository.dispatch('Actor', 'get', { query: { _id: 'world-actor' } });
    assert.equal(mirrored.length, 1, 'world document reads still mirror normally');
    assert.equal((mirrored[0].result as Array<{ _id: string }>)[0]._id, 'world-actor');
}

export async function run() {
    await runPackScopedDispatchSkipsWorldRouter();
    await runRepositorySkipsPackMirror();
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
