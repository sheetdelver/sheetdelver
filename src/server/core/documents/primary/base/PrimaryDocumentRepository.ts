import type { ModifyDocumentAction, PrimaryDocumentStore } from './PrimaryDocumentStore';

/**
 * Per-request document transport. The Repository wraps one of these so that
 * each mutation dispatches over the requesting user's authenticated socket/session.
 * See ADR-0011 for the identity-routing rationale.
 */
export interface DocumentTransport {
    dispatchDocument(
        type: string,
        action: string,
        operation?: unknown,
        parent?: { type: string; id: string },
    ): Promise<any>;
}

/**
 * Abstract base for every Foundry primary-document Repository.
 *
 * Wraps a request-scoped {@link DocumentTransport} so writes carry the requesting
 * user's identity. After Foundry returns the mutation result, the Repository
 * mirrors the change into the corresponding Store before returning to the caller —
 * the broadcast that lands later is then a no-op via the Store's emit-only-on-change rule.
 */
export abstract class PrimaryDocumentRepository<TDocument extends { id?: string; _id?: string }> {
    constructor(
        protected readonly transport: DocumentTransport,
        protected readonly store: PrimaryDocumentStore<TDocument>,
    ) {}

    /**
     * Generic dispatch with cache mirroring. Used by all CRUD methods on this
     * Repository and on subclasses; embedded operations pass a `parent` arg so
     * the broadcast routing can match the parentUuid shape on the way back in.
     */
    protected async dispatchDocument(
        type: string,
        action: ModifyDocumentAction,
        operation: Record<string, unknown> = {},
        parent?: { type: string; id: string },
    ): Promise<any> {
        // Bake parentUuid into the cache-side operation so the Store's embedded
        // routing can find the parent without re-parsing the wire payload.
        const cacheOperation = { ...operation };
        if (parent) cacheOperation.parentUuid = `${parent.type}.${parent.id}`;

        const response = await this.transport.dispatchDocument(type, action, operation, parent);

        // The initiator-side mirror. The broadcast that follows is idempotent
        // because the Store emits only on observable change.
        const appliedOperation = response?.operation
            ? { ...cacheOperation, ...response.operation }
            : cacheOperation;
        this.store.applyModifyDocument(type, action, response?.result ?? response, appliedOperation);
        return response;
    }
}
