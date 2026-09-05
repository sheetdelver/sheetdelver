import type { ItemDocument } from '@server/shared/types/actors';
import { PrimaryDocumentRepository, type DocumentTransport } from '../base/PrimaryDocumentRepository';
import type { ModifyDocumentAction } from '../base/PrimaryDocumentStore';
import { itemStore } from './ItemStore';

/**
 * World Item primary-document Repository. Per-request transport binds writes
 * to the requesting user's authenticated socket. Foundry's broadcast lands
 * through `modifyDocumentRouter` into `ItemStore.applyModifyDocument` (for
 * direct-type world Item ops) or `ItemStore.applyEmbeddedChange` (for
 * `ActiveEffect` ops with `parentUuid: Item.<id>`). The initiator-side mirror
 * in {@link dispatchDocument} makes the second apply idempotent via
 * emit-only-on-change.
 *
 * Embedded items on Actors continue to flow through `ActorRepository`
 * (`createActorItem` / `updateActorItem` / `deleteActorItem`); the two
 * Repositories coexist as clearly separate surfaces.
 */
export class ItemRepository extends PrimaryDocumentRepository<ItemDocument> {
    constructor(transport: DocumentTransport) {
        super(transport, itemStore);
    }

    async dispatchDocument(
        type: string,
        action: ModifyDocumentAction,
        operation: Record<string, unknown> = {},
        parent?: { type: string; id: string },
    ): Promise<any> {
        return super.dispatchDocument(type, action, operation, parent);
    }

    async create(data: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('Item', 'create', { data: [data] });
    }

    async update(itemId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('Item', 'update', {
            updates: [{ _id: itemId, ...updates }],
        });
    }

    async delete(itemId: string): Promise<void> {
        await this.dispatchDocument('Item', 'delete', { ids: [itemId] });
    }

    async createEffect(itemId: string, data: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument(
            'ActiveEffect',
            'create',
            { data: [data] },
            { type: 'Item', id: itemId },
        );
    }

    async updateEffect(itemId: string, effectId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument(
            'ActiveEffect',
            'update',
            { updates: [{ _id: effectId, ...updates }] },
            { type: 'Item', id: itemId },
        );
    }

    async deleteEffect(itemId: string, effectId: string): Promise<void> {
        await this.dispatchDocument(
            'ActiveEffect',
            'delete',
            { ids: [effectId] },
            { type: 'Item', id: itemId },
        );
    }
}
