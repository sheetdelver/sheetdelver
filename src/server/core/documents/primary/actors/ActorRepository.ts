import type { ActorDocument } from '@server/shared/types/actors';
import { PrimaryDocumentRepository, type DocumentTransport } from '../base/PrimaryDocumentRepository';
import type { ModifyDocumentAction } from '../base/PrimaryDocumentStore';
import { actorStore } from './ActorStore';

/**
 * Actor primary-document Repository. Per-request transport binding ensures
 * writes dispatch over the requesting user's authenticated socket/session
 * so Foundry enforces per-user permissions. Mirrors mutation results into
 * {@link ActorStore} via the base; the broadcast that follows is idempotent.
 */
export class ActorRepository extends PrimaryDocumentRepository<ActorDocument> {
    constructor(transport: DocumentTransport) {
        super(transport, actorStore);
    }

    // Public passthrough so route-scoped wrappers can still drive raw dispatches
    // (e.g., for ActiveEffect ops where the wrapper composes the parent type at the call site).
    async dispatchDocument(
        type: string,
        action: ModifyDocumentAction,
        operation: Record<string, unknown> = {},
        parent?: { type: string; id: string },
    ): Promise<any> {
        return super.dispatchDocument(type, action, operation, parent);
    }

    async createActor(
        actorData: Record<string, unknown> | Array<Record<string, unknown>>,
    ): Promise<Record<string, unknown> | Array<Record<string, unknown>> | null> {
        const batch = Array.isArray(actorData) ? actorData : [actorData];
        const response = await this.dispatchDocument('Actor', 'create', { data: batch });
        return Array.isArray(actorData) ? response?.result : response?.result?.[0] ?? null;
    }

    async updateActor(actorId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('Actor', 'update', { updates: [{ _id: actorId, ...updates }] });
    }

    async deleteActor(actorId: string): Promise<void> {
        await this.dispatchDocument('Actor', 'delete', { ids: [actorId] });
    }

    async createActorItem(
        actorId: string,
        itemData: Record<string, unknown> | Array<Record<string, unknown>>,
    ): Promise<any> {
        const batch = Array.isArray(itemData) ? itemData : [itemData];
        const response = await this.dispatchDocument('Item', 'create', { data: batch }, { type: 'Actor', id: actorId });
        return Array.isArray(itemData) ? response?.result : response?.result?.[0]?._id;
    }

    async updateActorItem(actorId: string, itemData: Record<string, unknown>): Promise<any> {
        const { _id, id, ...updates } = itemData;
        const targetId = _id || id;
        return this.dispatchDocument(
            'Item',
            'update',
            { updates: [{ _id: targetId, ...updates }] },
            { type: 'Actor', id: actorId },
        );
    }

    async deleteActorItem(actorId: string, itemId: string): Promise<void> {
        await this.dispatchDocument('Item', 'delete', { ids: [itemId] }, { type: 'Actor', id: actorId });
    }

    async createActorEffect(actorId: string, effectData: Record<string, unknown>): Promise<Record<string, unknown>> {
        const response = await this.dispatchDocument(
            'ActiveEffect',
            'create',
            { data: [effectData] },
            { type: 'Actor', id: actorId },
        );
        return response?.result?.[0] ?? response;
    }

    async updateActorEffect(
        actorId: string,
        effectId: string,
        updates: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
        const response = await this.dispatchDocument(
            'ActiveEffect',
            'update',
            { updates: [{ _id: effectId, ...updates }] },
            { type: 'Actor', id: actorId },
        );
        return response?.result?.[0] ?? response;
    }

    async deleteActorEffect(actorId: string, effectId: string): Promise<void> {
        await this.dispatchDocument(
            'ActiveEffect',
            'delete',
            { ids: [effectId] },
            { type: 'Actor', id: actorId },
        );
    }

    async createItemEffect(
        actorId: string,
        itemId: string,
        effectData: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
        const response = await this.dispatchDocument(
            'ActiveEffect',
            'create',
            { data: [effectData] },
            { type: `Actor.${actorId}.Item`, id: itemId },
        );
        return response?.result?.[0] ?? response;
    }

    async updateItemEffect(
        actorId: string,
        itemId: string,
        effectId: string,
        updates: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
        const response = await this.dispatchDocument(
            'ActiveEffect',
            'update',
            { updates: [{ _id: effectId, ...updates }] },
            { type: `Actor.${actorId}.Item`, id: itemId },
        );
        return response?.result?.[0] ?? response;
    }

    async deleteItemEffect(actorId: string, itemId: string, effectId: string): Promise<void> {
        await this.dispatchDocument(
            'ActiveEffect',
            'delete',
            { ids: [effectId] },
            { type: `Actor.${actorId}.Item`, id: itemId },
        );
    }
}
