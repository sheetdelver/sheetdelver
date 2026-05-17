import type { AppConfig } from '@shared/interfaces';
import { logger } from '@shared/utils/logger';
import { getAdapter, getMatchingAdapter } from '@modules/registry/server';
import type {
    RawActor,
    RawItem,
    ActorCard,
    ActorRollPayload,
    ActorServiceClientLike,
} from '@server/shared/types/actors';
import type {
    ActorListPayload,
    ActorCardsPayload,
    ActorDetailPayload,
    ActorErrorPayload,
} from '@shared/contracts/actors';

interface ActorProjection extends ActorDetailPayload {
    foundryUrl?: string;
    systemId?: string;
    debugLevel?: number;
    derived?: Record<string, unknown>;
    categorizedItems?: Record<string, unknown>;
    img?: string;
    prototypeToken?: {
        texture?: {
            src?: string;
        };
    };
    [key: string]: unknown;
}

interface ActorRollData {
    formula?: string;
    label?: string;
    flags?: unknown;
    isAutomated?: boolean;
    [key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

interface ActorServiceDeps {
    normalizeActors: (actorList: RawActor[], client: ActorServiceClientLike) => Promise<ActorProjection[]>;
    config: AppConfig;
}

export function createActorService(deps: ActorServiceDeps) {
    // Dashboard list and card data are derived from the same actor list. Keep the
    // card projection here so `/api/actors` does not force a second actor read.
    const buildActorCards = (
        actors: RawActor[],
        adapter: { getActorCardData?: (actor: any) => unknown } | null | undefined,
    ): ActorCardsPayload => {
        if (!adapter?.getActorCardData) return {};

        const cards: Record<string, ActorCard> = {};
        for (const actor of actors) {
            const id = actor._id || actor.id;
            if (id) cards[id] = adapter.getActorCardData(actor as any) as ActorCard;
        }
        return cards;
    };

    // Actor list projection: owned/read-only partition + normalized payload.
    const listActors = async (client: ActorServiceClientLike): Promise<ActorListPayload> => {
        const systemInfo = await client.getSystem();
        const adapter = await getAdapter(systemInfo.id.toLowerCase());
        if (!adapter) throw new Error(`Adapter for ${systemInfo.id} not found`);

        const rawActors = await client.getActors();
        const normalize = async (actorList: RawActor[]) => deps.normalizeActors(actorList, client);
        const currentUserId = client.userId;

        const actorTypes = new Set(rawActors.map((a) => a.type));
        const actorFolders = new Set(rawActors.map((a) => a.folder).filter(Boolean));
        logger.info(`Core Service | Actor types found: ${Array.from(actorTypes).join(', ')}`);
        logger.info(`Core Service | Actor folders found: ${Array.from(actorFolders).join(', ')}`);

        const owned = rawActors.filter((a) =>
            a.ownership?.[currentUserId!] === 3 || a.ownership?.default === 3
        );

        const observable = rawActors.filter((a) => {
            const isOwned = owned.includes(a);
            if (isOwned) return false;

            const userPermission = a.ownership?.[currentUserId!] || a.ownership?.default || 0;
            const isObservable = userPermission >= 1;
            const actorType = (a.type || '').toLowerCase();
            const isNPC = actorType === 'npc' || actorType === 'monster' || actorType === 'vehicle';

            return isObservable && !isNPC;
        });

        const ownedCharacters = owned.filter((a) => {
            const actorType = (a.type || '').toLowerCase();
            const isNPC = actorType === 'npc' || actorType === 'monster' || actorType === 'vehicle';
            return !isNPC;
        });

        logger.info(`Core Service | Filtered actors - Owned: ${ownedCharacters.length}, Observable: ${observable.length}, Total raw: ${rawActors.length}`);

        return {
            actors: await normalize(ownedCharacters),
            ownedActors: await normalize(ownedCharacters),
            readOnlyActors: await normalize(observable),
            // Cards are included for the visible dashboard set only. The legacy
            // `/actors/cards` endpoint remains for clients that still call it.
            actorCards: buildActorCards([...ownedCharacters, ...observable], adapter),
            system: systemInfo.id
        };
    };

    // Actor card projections used by dashboard card views.
    const getActorCards = async (client: ActorServiceClientLike): Promise<ActorCardsPayload> => {
        const systemInfo = await client.getSystem();
        const adapter = await getAdapter(systemInfo.id.toLowerCase());
        if (!adapter || !adapter.getActorCardData) {
            return {};
        }

        return buildActorCards(await client.getActors(), adapter);
    };

    const getActorCardById = async (
        client: ActorServiceClientLike,
        actorId: string
    ): Promise<ActorCard | ActorErrorPayload | Record<string, never>> => {
        const actor = await client.getActor(actorId);
        if (!actor || actor.error) {
            return {
                error: actor?.error || 'Actor not found',
                status: actor?.error ? 503 : 404
            };
        }

        const systemInfo = await client.getSystem();
        const adapter = await getAdapter(systemInfo.id.toLowerCase());
        if (!adapter || !adapter.getActorCardData) {
            return {};
        }

        return adapter.getActorCardData!(actor as any) as ActorCard;
    };

    // Actor detail resolver: UUID resolution + adapter normalization + derived data.
    const getActorById = async (
        client: ActorServiceClientLike,
        actorId: string
    ): Promise<ActorDetailPayload | ActorErrorPayload> => {
        const actor = await client.getActor(actorId);
        if (!actor || actor.error) {
            return {
                error: actor?.error || 'Actor not found',
                status: actor?.error ? 503 : 404
            };
        }

        const { CompendiumCache } = await import('@core/foundry/compendium-cache');
        const cache = CompendiumCache.getInstance();

        const resolveUUIDs = (obj: unknown): unknown => {
            if (typeof obj === 'string') {
                if (obj.startsWith('Compendium.')) {
                    const name = cache.getName(obj);
                    return name || obj;
                }
                return obj;
            }
            if (Array.isArray(obj)) return obj.map(item => resolveUUIDs(item));
            if (isRecord(obj)) {
                const newObj: Record<string, unknown> = {};
                for (const key of Object.keys(obj)) newObj[key] = resolveUUIDs(obj[key]);
                return newObj;
            }
            return obj;
        };

        const resolvedActor = resolveUUIDs(actor) as RawActor;

        const systemInfo = await client.getSystem();
        const adapter = await getAdapter(systemInfo.id.toLowerCase())
            ?? await getMatchingAdapter(resolvedActor);

        if (!adapter) throw new Error(`Adapter for ${systemInfo.id} not found`);

        const normalizedActor: ActorProjection = adapter.normalizeActorData(resolvedActor as any, client as any);

        if (adapter.computeActorData) {
            normalizedActor.derived = {
                ...(normalizedActor.derived || {}),
                ...(adapter.computeActorData(normalizedActor as any) as Record<string, unknown>)
            };
        }

        if (adapter.categorizeItems) {
            normalizedActor.categorizedItems = adapter.categorizeItems(normalizedActor as any) as Record<string, unknown>;
        }

        if (normalizedActor.img) {
            normalizedActor.img = client.resolveUrl(normalizedActor.img);
        }
        if (normalizedActor.prototypeToken?.texture?.src) {
            normalizedActor.prototypeToken.texture.src = client.resolveUrl(normalizedActor.prototypeToken.texture.src);
        }

        return {
            ...normalizedActor,
            foundryUrl: client.url,
            systemId: adapter.systemId,
            // The Foundry system ID is always the real game system (e.g. 'dnd5e')
            // regardless of whether that system's module is enabled. The client
            // uses this to stay subscribed to moduleStateChanged events even when
            // the module is disabled and systemId falls back to 'generic'.
            foundrySystemId: systemInfo.id.toLowerCase(),
            debugLevel: deps.config.debug?.level ?? 1
        };
    };

    // Actor write operations and item mutation helpers.
    const createActor = async (client: ActorServiceClientLike, actorData: Record<string, unknown>) => {
        if (actorData.items && Array.isArray(actorData.items)) {
            actorData.items.forEach((item: RawItem) => {
                if (item.effects && Array.isArray(item.effects)) {
                    if (item.effects.length > 0 && typeof item.effects[0] === 'string') {
                        logger.warn(`Core Service | Clearing invalid string effects for ${item.name} during creation`);
                        item.effects = [];
                    }
                }

                if (item.system) {
                    for (const key of Object.keys(item.system)) {
                        if (Array.isArray(item.system[key]) && (item.system[key].length === 0 || typeof item.system[key][0] === 'string')) {
                            delete item.system[key];
                        }
                    }
                }
            });
        }

        logger.debug('Core Service | Create Actor:', actorData);
        const newActor = await client.createActor(actorData) as RawActor | null | undefined;
        if (!newActor) throw new Error('Failed to create actor');

        return { success: true, id: newActor._id || newActor.id, actor: newActor };
    };

    const deleteActor = async (client: ActorServiceClientLike, actorId: string) => {
        await client.deleteActor(actorId);
        return { success: true };
    };

    const updateActor = async (client: ActorServiceClientLike, actorId: string, payload: Record<string, unknown>) => {
        const result = await client.updateActor(actorId, payload);
        return { success: true, result };
    };

    // Roll orchestration with adapter-aware automated sequence fallback.
    const rollActor = async (client: ActorServiceClientLike, actorId: string, payload: ActorRollPayload) => {
        const { type, key, options } = payload;
        const actor = await client.getActor(actorId);
        if (!actor) return { error: 'Actor not found', status: 404 };

        const systemInfo = await client.getSystem();
        const adapter = await getAdapter(systemInfo.id.toLowerCase());
        if (!adapter) throw new Error(`Adapter ${systemInfo.id} not found`);

        if (type === 'use-item') {
            let itemId = key;
            const isId = actor.items?.some((i) => (i._id || i.id) === key);
            if (!isId) {
                const allItems = [
                    ...(actor.items || []),
                    ...(actor.categorizedItems?.feats || []),
                    ...(actor.categorizedItems?.uncategorized || [])
                ];
                const found = allItems.find((i) => i.name === key);
                const foundId = found?._id || found?.id;
                if (foundId) itemId = foundId;
            }
            if (!itemId) throw new Error('Could not resolve item id');
            const result = await client.useItem(actorId, itemId);
            return { success: true, result };
        }

        let rollData: ActorRollData | undefined;
        if (type === 'formula') {
            rollData = { formula: key, label: 'Custom Roll' };
        } else if (adapter.getRollData) {
            rollData = adapter.getRollData(actor as any, type, key, options) as ActorRollData;
        }

        if (!rollData) throw new Error('Cannot determine roll formula');

        if (rollData.isAutomated && typeof adapter.performAutomatedSequence === 'function') {
            const result = await adapter.performAutomatedSequence(client as any, actor as any, rollData, options);
            return { success: true, result, label: rollData.label };
        }

        if (!rollData.formula) {
            throw new Error(`No roll formula for type "${type}" key "${key}"`);
        }
        const rollLabel = rollData.label || 'Roll';

        const speaker = options?.speaker || {
            actor: actor._id || actor.id,
            alias: actor.name
        };

        const result = await client.roll(rollData.formula, rollLabel, {
            rollMode: options?.rollMode,
            speaker,
            flags: rollData.flags
        });

        return { success: true, result, label: rollLabel };
    };

    const createActorItem = async (client: ActorServiceClientLike, actorId: string, payload: Record<string, unknown>) => {
        const newItemId = await client.createActorItem(actorId, payload);
        return { success: true, id: newItemId };
    };

    const updateActorItem = async (client: ActorServiceClientLike, actorId: string, payload: Record<string, unknown>) => {
        await client.updateActorItem(actorId, payload);
        return { success: true };
    };

    const deleteActorItem = async (client: ActorServiceClientLike, actorId: string, itemId: string) => {
        if (!itemId) return { success: false, error: 'Missing itemId', status: 400 };
        await client.deleteActorItem(actorId, itemId);
        return { success: true };
    };

    // Unified update splitter for mixed actor/item patch payloads.
    const updateActorAndItems = async (client: ActorServiceClientLike, actorId: string, body: Record<string, unknown>) => {
        const actorUpdates: Record<string, unknown> = {};
        const itemUpdates: Map<string, Record<string, unknown>> = new Map();

        let updatesToProcess: Record<string, unknown> = {};
        if (body.path !== undefined && body.value !== undefined) {
            updatesToProcess[String(body.path)] = body.value;
        } else {
            updatesToProcess = body;
        }

        for (const [path, value] of Object.entries(updatesToProcess)) {
            if (path.startsWith('items.')) {
                const parts = path.split('.');
                if (parts.length >= 2) {
                    const itemId = parts[1];
                    const itemProp = parts.slice(2).join('.');
                    if (itemProp) {
                        if (!itemUpdates.has(itemId)) itemUpdates.set(itemId, {});
                        itemUpdates.get(itemId)![itemProp] = value;
                    }
                }
            } else {
                actorUpdates[path] = value;
            }
        }

        for (const [itemId, updates] of itemUpdates.entries()) {
            logger.debug(`Core Service | Routing update to item ${itemId}: ${JSON.stringify(updates)}`);
            await client.updateActorItem(actorId, { _id: itemId, ...updates });
        }

        if (Object.keys(actorUpdates).length > 0) {
            await client.updateActor(actorId, actorUpdates);
        }

        return { success: true };
    };

    return {
        listActors,
        getActorCards,
        getActorCardById,
        getActorById,
        createActor,
        deleteActor,
        updateActor,
        rollActor,
        createActorItem,
        updateActorItem,
        deleteActorItem,
        updateActorAndItems
    };
}
