import type { RouteFoundryClient } from '@server/shared/types/requestContext';
import type { ModuleFoundryClient } from '@shared/sdk';
import { simulateTableDraw } from '@shared/sdk/utils';

/**
 * Wraps a RouteFoundryClient (the core's internal type) to satisfy the
 * ModuleFoundryClient interface exposed to external modules via the SDK.
 *
 * This keeps the module-facing surface stable and decoupled from internal
 * changes to RouteFoundryClient.
 */
export function createModuleFoundryClient(client: RouteFoundryClient): ModuleFoundryClient {
    return {
        get isConnected() {
            return client.isConnected;
        },

        // --- Messaging and actions ---

        roll: (formula, label, options) =>
            client.roll(formula, label ?? '', options) as any,

        sendMessage: (data, options) =>
            client.sendMessage(data.content as string, {
                rollMode: options?.rollMode as any,
                speaker: options?.speaker as any,
            }) as any,

        useItem: (actorId, itemId) =>
            client.useItem(actorId, itemId) as any,

        // --- Actor CRUD ---

        getActor: (id) =>
            client.getActor(id) as Promise<Record<string, unknown>>,

        getActors: () =>
            client.getActors() as Promise<Record<string, unknown>[]>,

        createActor: (actorData) =>
            client.createActor(actorData) as Promise<Record<string, unknown>>,

        updateActor: (id, updates) =>
            client.updateActor(id, updates) as Promise<Record<string, unknown>>,

        deleteActor: (actorId) =>
            client.deleteActor(actorId),

        // --- Actor Item CRUD ---

        createActorItem: (actorId, itemData) =>
            client.createActorItem(actorId, itemData) as Promise<Record<string, unknown>>,

        updateActorItem: (actorId, itemData) =>
            client.updateActorItem(actorId, itemData) as any,

        deleteActorItem: (actorId, itemId) =>
            client.deleteActorItem(actorId, itemId),

        // --- Actor Active Effect CRUD ---

        createActorEffect: (actorId, effectData) =>
            client.dispatchDocument(
                'ActiveEffect', 'create',
                { data: [effectData] },
                { type: 'Actor', id: actorId }
            ) as Promise<Record<string, unknown>>,

        updateActorEffect: (actorId, effectId, updates) =>
            client.dispatchDocument(
                'ActiveEffect', 'update',
                { updates: [{ _id: effectId, ...updates }] },
                { type: 'Actor', id: actorId }
            ) as Promise<Record<string, unknown>>,

        deleteActorEffect: async (actorId, effectId) => {
            await client.dispatchDocument(
                'ActiveEffect', 'delete',
                { ids: [effectId] },
                { type: 'Actor', id: actorId }
            );
        },

        // --- Item Active Effect operations ---

        updateItemEffect: (actorId, itemId, effectId, updates) =>
            client.dispatchDocument(
                'ActiveEffect', 'update',
                { updates: [{ _id: effectId, ...updates }] },
                { type: `Actor.${actorId}.Item`, id: itemId }
            ) as Promise<Record<string, unknown>>,

        deleteItemEffect: async (actorId, itemId, effectId) => {
            await client.dispatchDocument(
                'ActiveEffect', 'delete',
                { ids: [effectId] },
                { type: `Actor.${actorId}.Item`, id: itemId }
            );
        },

        // --- World document access ---

        fetchByUuid: (uuid) =>
            client.fetchByUuid(uuid) as Promise<Record<string, unknown>>,

        getWorldItems: async (options) => {
            const response = await client.dispatchDocument(
                'Item', 'get',
                { broadcast: false }
            ) as any;
            const items: Record<string, unknown>[] = Array.isArray(response)
                ? response
                : (response?.result ?? []);
            if (options?.type) {
                return items.filter((i: any) => i.type === options.type);
            }
            return items;
        },

        drawTable: async (tableId, options) => {
            const table = await client.fetchByUuid(tableId) as Record<string, unknown>;
            if (!table) throw new Error(`RollTable not found: ${tableId}`);

            return simulateTableDraw(table, {
                rollOverride: options?.rollOverride,
                fetchDocument: async (uuid) => {
                    try {
                        return await client.fetchByUuid(uuid) as Record<string, unknown>;
                    } catch {
                        return null;
                    }
                },
            });
        },

        // --- Utilities ---

        resolveUrl: (path) =>
            client.resolveUrl(path),

        getSystemId: async () => {
            const system = await client.getSystem();
            return system.id;
        },
    };
}
