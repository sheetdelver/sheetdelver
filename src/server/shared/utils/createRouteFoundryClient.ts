import type { RollMode } from '@shared/sdk';
import type { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { ClientSocket } from '@core/foundry/sockets/ClientSocket';
import type { ChatSendBody } from '@server/shared/types/documents';
import type { RouteFoundryClient } from '@server/shared/types/requestContext';
import { logger } from '@shared/utils/logger';
import { systemService } from '@server/core/system/SystemService';
import { compendiumStore } from '@server/core/compendium';
import { CompendiumService } from '@server/services/compendium';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { ActorRepository } from '@server/core/documents/primary/actors/ActorRepository';
import { ChatMessageRepository } from '@server/core/documents/primary/chat-messages/ChatMessageRepository';
import {
    createTextChatMessageData,
    normalizeSpeaker,
    resolveRollModeData,
} from '@server/core/documents/primary/chat-messages/chatMessagePayload';
import { CombatRepository } from '@server/core/documents/primary/combats/CombatRepository';
import { FolderRepository } from '@server/core/documents/primary/folders/FolderRepository';
import { CardsRepository } from '@server/core/documents/primary/cards/CardsRepository';
import { ItemRepository } from '@server/core/documents/primary/items/ItemRepository';
import { JournalRepository } from '@server/core/documents/primary/journals/JournalRepository';
import { MacroRepository } from '@server/core/documents/primary/macros/MacroRepository';
import { PlaylistRepository } from '@server/core/documents/primary/playlists/PlaylistRepository';
import { RollTableRepository } from '@server/core/documents/primary/roll-tables/RollTableRepository';
import {
    DOCUMENT_VISIBILITY,
} from '@server/core/documents/primary/base/ownership';
import { PrimaryDocumentCacheNotReadyError } from '@server/core/documents/primary/errors';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';

type RouteSocketClient = CoreSocket | ClientSocket;

function ensureActorStoreReady(): void {
    if (!actorStore.isReady()) throw new PrimaryDocumentCacheNotReadyError('Actor');
}

function filterActorUpdatePayload(
    client: RouteSocketClient,
    actorId: string,
    payload: Record<string, unknown>,
): Record<string, unknown> | null {
    const adapter = client.getSystemAdapter();
    if (!adapter?.validateUpdate) return payload;

    const filteredData: Record<string, unknown> = {};
    let hasValidUpdates = false;

    for (const [path, value] of Object.entries(payload)) {
        if (adapter.validateUpdate(path, value)) {
            filteredData[path] = value;
            hasValidUpdates = true;
        } else {
            logger.warn(`RouteFoundryClient | Rejected unsanctioned update path: ${path} for actor ${actorId}`);
        }
    }

    if (!hasValidUpdates) {
        logger.info(`RouteFoundryClient | No sanctioned updates to process for actor ${actorId}`);
        return null;
    }

    return filteredData;
}

function createBaseRouteFoundryClient(client: RouteSocketClient): RouteFoundryClient {
    const getSubject = () => userStore.createAccessSubject(client.userId);
    const getCompendiumService = () => {
        // Route facades keep the legacy method shape for now, but ADR-0015
        // Phase 2 routes Pathway A reads through CompendiumService. User
        // sockets continue to use the system socket as the actual transport.
        const transport = client instanceof ClientSocket ? systemService.getSystemClient() : client;
        return new CompendiumService({
            transport,
            store: compendiumStore,
            getGameDataSnapshot: () => worldStateStore.getGameDataSnapshot(),
        });
    };
    // Repositories wrap the request-bound socket so Foundry sees the right user.
    const documentTransport = {
        dispatchDocument: (
            type: string,
            action: string,
            operation?: unknown,
            parent?: { type: string; id: string },
        ) => client.dispatchDocument(type, action, operation, parent),
    };
    const actorRepository = new ActorRepository(documentTransport);
    const chatMessageRepository = new ChatMessageRepository(documentTransport);
    const combatRepository = new CombatRepository(documentTransport);
    const folderRepository = new FolderRepository(documentTransport);
    const cardsRepository = new CardsRepository(documentTransport);
    const itemRepository = new ItemRepository(documentTransport);
    const journalRepository = new JournalRepository(documentTransport);
    const macroRepository = new MacroRepository(documentTransport);
    const playlistRepository = new PlaylistRepository(documentTransport);
    const rollTableRepository = new RollTableRepository(documentTransport);

    const getActors = async () => {
        ensureActorStoreReady();
        const subject = getSubject();
        if (!subject) return actorStore.list();
        return actorStore.listActors({ subject, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE });
    };

    const getActor = async (actorId: string) => {
        // This remains LIST_VISIBLE until route-specific detail/card thresholds split.
        ensureActorStoreReady();
        const subject = getSubject();
        if (!subject) return actorStore.get(actorId);
        return actorStore.getActor(actorId, { subject, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE });
    };

    const getActorRaw = async (actorId: string) => {
        ensureActorStoreReady();
        return actorStore.get(actorId);
    };

    const createChatMessageDocument = async (data: Record<string, unknown>) => {
        const response = await chatMessageRepository.send(data);
        return response?.result?.[0] ?? response;
    };

    const roll = async (
        formula: string,
        flavor?: string,
        options?: {
            rollMode?: RollMode;
            speaker?: ChatSendBody['speaker'];
            displayChat?: boolean;
            flags?: unknown;
        },
    ) => {
        try {
            const { Roll } = await import('@core/foundry/Roll');
            const evaluatedRoll = new Roll(formula);
            await evaluatedRoll.evaluate();

            const author = client.userId;
            const chatData: Record<string, unknown> = {
                author,
                content: String(evaluatedRoll.total),
                flavor,
                type: 5,
                rolls: [JSON.stringify(evaluatedRoll.toJSON())],
                flags: options?.flags || {},
                sound: 'sounds/dice.wav',
            };

            const speaker = normalizeSpeaker(options?.speaker);
            if (speaker) chatData.speaker = speaker;

            Object.assign(
                chatData,
                await resolveRollModeData(options?.rollMode, author, () => userStore.getGmUserIds()),
            );

            if (options?.displayChat !== false) return createChatMessageDocument(chatData);
            return { ...chatData, _synthetic: true };
        } catch (error: unknown) {
            const message = getErrorMessage(error);
            logger.error(`RouteFoundryClient | Roll failed: ${message}`);
            if (options?.displayChat !== false) {
                const fallbackData = await createTextChatMessageData({
                    content: `Rolling ${formula}: ${flavor || ''} (Error: ${message})`,
                    author: client.userId,
                    getGmUserIds: () => userStore.getGmUserIds(),
                });
                return createChatMessageDocument(fallbackData);
            }
            throw error;
        }
    };

    const useItem = async (actorId: string, itemId: string) => {
        const actor = await getActor(actorId);
        const item = actor?.items?.find((candidate: { _id?: string; id?: string }) =>
            candidate._id === itemId || candidate.id === itemId
        );
        if (!actor || !item) return false;

        const chatData = await createTextChatMessageData({
            content: `<b>${actor.name}</b> uses <b>${item.name}</b>`,
            author: client.userId,
            getGmUserIds: () => userStore.getGmUserIds(),
        });
        await createChatMessageDocument(chatData);
        return true;
    };

    return {
        get isConnected() {
            return client.isConnected;
        },
        userId: client.userId,
        username: undefined,
        on: client.on.bind(client),
        off: client.off.bind(client),
        getSystem: async () => {
            // Public facade retained for routes/modules. Internally this is
            // Store-backed now; callers should not care that CoreSocket no
            // longer owns system metadata.
            const system = worldStateStore.getSystem();
            return { ...(system || {}), id: system?.id || '' };
        },
        getActors,
        getActor,
        getActorRaw,
        createActor: (actorData: Record<string, unknown> | Array<Record<string, unknown>>) => actorRepository.createActor(actorData),
        deleteActor: (actorId: string) => actorRepository.deleteActor(actorId),
        updateActor: async (actorId: string, payload: Record<string, unknown>) => {
            const filteredPayload = filterActorUpdatePayload(client, actorId, payload);
            if (!filteredPayload) return { success: true, message: 'No sanctioned updates' };
            return actorRepository.updateActor(actorId, filteredPayload);
        },
        dispatchDocument: (
            type: string,
            action: string,
            operation?: unknown,
            parent?: { type: string; id: string }
        ) => {
            const normalizedAction = action as 'get' | 'create' | 'update' | 'delete';
            const normalizedOperation = operation as Record<string, unknown> | undefined;
            const parentRootType = typeof parent?.type === 'string'
                ? parent.type.split('.')[0]
                : undefined;

            // Repository routing priority (ADR-0011 Phase 6):
            //   1. `parent` arg supplied → route to the parent-owning Repository.
            //      Embedded `Item` / `ActiveEffect` under an Actor go to
            //      ActorRepository regardless of `type`, including nested parent
            //      forms like `Actor.<actorId>.Item`. ActiveEffect under a world
            //      Item goes to ItemRepository.
            //   2. No parent → direct-type Repository for the world-level doc.
            if (parentRootType === 'Actor') {
                return actorRepository.dispatchDocument(type, normalizedAction, normalizedOperation, parent);
            }
            if (parentRootType === 'Item') {
                return itemRepository.dispatchDocument(type, normalizedAction, normalizedOperation, parent);
            }
            if (parentRootType === 'RollTable') {
                return rollTableRepository.dispatchDocument(type, normalizedAction, normalizedOperation, parent);
            }
            if (parentRootType === 'Playlist') {
                return playlistRepository.dispatchDocument(type, normalizedAction, normalizedOperation, parent);
            }
            if (parentRootType === 'Cards') {
                return cardsRepository.dispatchDocument(type, normalizedAction, normalizedOperation, parent);
            }

            if (type === 'Actor') {
                return actorRepository.dispatchDocument(type, normalizedAction, normalizedOperation, parent);
            }

            if (type === 'Item') {
                return itemRepository.dispatchDocument(type, normalizedAction, normalizedOperation, parent);
            }

            if (type === 'ChatMessage') {
                return chatMessageRepository.dispatchDocument(type, normalizedAction, normalizedOperation, parent);
            }

            if (type === 'Folder') {
                return folderRepository.dispatchDocument(type, normalizedAction, normalizedOperation, parent);
            }

            if (type === 'JournalEntry' || type === 'JournalEntryPage') {
                return journalRepository.dispatchDocument(type, normalizedAction, normalizedOperation, parent);
            }

            if (type === 'Combat' || type === 'Combatant') {
                return combatRepository.dispatchDocument(type, normalizedAction, normalizedOperation, parent);
            }

            if (type === 'RollTable') {
                return rollTableRepository.dispatchDocument(type, normalizedAction, normalizedOperation, parent);
            }

            if (type === 'Macro') {
                return macroRepository.dispatchDocument(type, normalizedAction, normalizedOperation, parent);
            }

            if (type === 'Playlist') {
                return playlistRepository.dispatchDocument(type, normalizedAction, normalizedOperation, parent);
            }

            if (type === 'Cards') {
                return cardsRepository.dispatchDocument(type, normalizedAction, normalizedOperation, parent);
            }

            return client.dispatchDocument(type, action, operation, parent);
        },
        roll,
        useItem,
        createActorItem: (
            actorId: string,
            payload: Record<string, unknown> | Array<Record<string, unknown>>
        ) => actorRepository.createActorItem(actorId, payload),
        updateActorItem: (actorId: string, payload: Record<string, unknown>) => actorRepository.updateActorItem(actorId, payload),
        deleteActorItem: (actorId: string, itemId: string) => actorRepository.deleteActorItem(actorId, itemId),
        resolveUrl: (url?: string) => client.resolveUrl(url || ''),
        createChatMessage: (data: Record<string, unknown>) => chatMessageRepository.send(data),
        fetchByUuid: (uuid: string) => client.fetchByUuid(uuid),
        getAllCompendiumIndices: () => getCompendiumService().discoverIndices(),
    };
}

export function createSystemRouteFoundryClient(client: CoreSocket): RouteFoundryClient {
    return createBaseRouteFoundryClient(client);
}

export function createSessionRouteFoundryClient(client: ClientSocket, username?: string): RouteFoundryClient {
    return {
        ...createBaseRouteFoundryClient(client),
        username,
    };
}
