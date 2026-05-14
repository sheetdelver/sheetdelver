import { actorStore } from './ActorStore';
import type { ActorMutationAction } from './ActorStore';

export interface ActorDocumentTransport {
    dispatchDocument(
        type: string,
        action: string,
        operation?: unknown,
        parent?: { type: string; id: string },
    ): Promise<any>;
}

export class ActorRepository {
    constructor(private readonly transport: ActorDocumentTransport) {}

    async dispatchDocument(
        type: string,
        action: ActorMutationAction,
        operation: Record<string, unknown> = {},
        parent?: { type: string; id: string },
    ): Promise<any> {
        const cacheOperation = { ...operation };
        if (parent) cacheOperation.parentUuid = `${parent.type}.${parent.id}`;

        const response = await this.transport.dispatchDocument(type, action, operation, parent);
        const appliedOperation = response?.operation
            ? { ...cacheOperation, ...response.operation }
            : cacheOperation;
        actorStore.applyModifyDocument(type, action, response?.result ?? response, appliedOperation);
        return response;
    }

    async createActor(actorData: Record<string, unknown>): Promise<Record<string, unknown> | null> {
        const batch = Array.isArray(actorData) ? actorData : [actorData];
        const response = await this.dispatchDocument('Actor', 'create', { data: batch });
        return Array.isArray(actorData) ? response?.result : response?.result?.[0] ?? null;
    }

    async deleteActor(actorId: string): Promise<void> {
        await this.dispatchDocument('Actor', 'delete', { ids: [actorId] });
    }

    async createActorItem(actorId: string, itemData: Record<string, unknown> | Array<Record<string, unknown>>): Promise<any> {
        const batch = Array.isArray(itemData) ? itemData : [itemData];
        const response = await this.dispatchDocument('Item', 'create', { data: batch }, { type: 'Actor', id: actorId });
        return Array.isArray(itemData) ? response?.result : response?.result?.[0]?._id;
    }

    async updateActorItem(actorId: string, itemData: Record<string, unknown>): Promise<any> {
        const { _id, id, ...updates } = itemData;
        const targetId = _id || id;
        return this.dispatchDocument('Item', 'update', { updates: [{ _id: targetId, ...updates }] }, { type: 'Actor', id: actorId });
    }

    async deleteActorItem(actorId: string, itemId: string): Promise<void> {
        await this.dispatchDocument('Item', 'delete', { ids: [itemId] }, { type: 'Actor', id: actorId });
    }

    async createActorEffect(actorId: string, effectData: Record<string, unknown>): Promise<Record<string, unknown>> {
        const response = await this.dispatchDocument('ActiveEffect', 'create', { data: [effectData] }, { type: 'Actor', id: actorId });
        return response?.result?.[0] ?? response;
    }

    async updateActorEffect(actorId: string, effectId: string, updates: Record<string, unknown>): Promise<Record<string, unknown>> {
        const response = await this.dispatchDocument('ActiveEffect', 'update', { updates: [{ _id: effectId, ...updates }] }, { type: 'Actor', id: actorId });
        return response?.result?.[0] ?? response;
    }

    async deleteActorEffect(actorId: string, effectId: string): Promise<void> {
        await this.dispatchDocument('ActiveEffect', 'delete', { ids: [effectId] }, { type: 'Actor', id: actorId });
    }

    async createItemEffect(actorId: string, itemId: string, effectData: Record<string, unknown>): Promise<Record<string, unknown>> {
        const response = await this.dispatchDocument('ActiveEffect', 'create', { data: [effectData] }, { type: `Actor.${actorId}.Item`, id: itemId });
        return response?.result?.[0] ?? response;
    }

    async updateItemEffect(actorId: string, itemId: string, effectId: string, updates: Record<string, unknown>): Promise<Record<string, unknown>> {
        const response = await this.dispatchDocument('ActiveEffect', 'update', { updates: [{ _id: effectId, ...updates }] }, { type: `Actor.${actorId}.Item`, id: itemId });
        return response?.result?.[0] ?? response;
    }

    async deleteItemEffect(actorId: string, itemId: string, effectId: string): Promise<void> {
        await this.dispatchDocument('ActiveEffect', 'delete', { ids: [effectId] }, { type: `Actor.${actorId}.Item`, id: itemId });
    }
}
