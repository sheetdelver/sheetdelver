import type { RollMode } from '@shared/sdk';
import type { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import type { ClientSocket } from '@core/foundry/sockets/ClientSocket';
import type { ChatSendBody } from '@server/shared/types/documents';
import type { RouteFoundryClient } from '@server/shared/types/requestContext';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { ActorRepository } from '@server/core/documents/primary/actors/ActorRepository';
import { ChatMessageRepository } from '@server/core/documents/primary/chat-messages/ChatMessageRepository';
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

function ensureActorStoreReady(): void {
    if (!actorStore.isReady()) throw new PrimaryDocumentCacheNotReadyError('Actor');
}

function createBaseRouteFoundryClient(client: CoreSocket | ClientSocket): RouteFoundryClient {
    const getSubject = () => userStore.createAccessSubject(client.userId);
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

    return {
        get isConnected() {
            return client.isConnected;
        },
        userId: client.userId,
        username: undefined,
        on: client.on.bind(client),
        off: client.off.bind(client),
        getSystem: () => client.getSystem(),
        getActors: async () => {
            ensureActorStoreReady();
            const subject = getSubject();
            if (!subject) return actorStore.list();
            return actorStore.listActors({ subject, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE });
        },
        getActor: async (actorId: string) => {
            // This remains LIST_VISIBLE until route-specific detail/card thresholds split.
            ensureActorStoreReady();
            const subject = getSubject();
            if (!subject) return actorStore.get(actorId);
            return actorStore.getActor(actorId, { subject, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE });
        },
        getActorRaw: async (actorId: string) => {
            ensureActorStoreReady();
            return actorStore.get(actorId);
        },
        createActor: (actorData: Record<string, unknown>) => actorRepository.createActor(actorData),
        deleteActor: (actorId: string) => actorRepository.deleteActor(actorId),
        updateActor: async (actorId: string, payload: Record<string, unknown>) => {
            // Keep ClientSocket's validateUpdate path, then mirror the result into ActorStore.
            const result = await client.updateActor(actorId, payload);
            actorStore.applyModifyDocument('Actor', 'update', result?.result ?? result, result?.operation ?? { updates: [{ _id: actorId, ...payload }] });
            return result;
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
        roll: (
            formula: string,
            label?: string,
            options?: {
                rollMode?: RollMode;
                speaker?: ChatSendBody['speaker'];
                displayChat?: boolean;
                flags?: unknown;
            }
        ) => client.roll(formula, label, options),
        useItem: (actorId: string, itemId: string) => client.useItem(actorId, itemId),
        createActorItem: (
            actorId: string,
            payload: Record<string, unknown> | Array<Record<string, unknown>>
        ) => actorRepository.createActorItem(actorId, payload),
        updateActorItem: (actorId: string, payload: Record<string, unknown>) => actorRepository.updateActorItem(actorId, payload),
        deleteActorItem: (actorId: string, itemId: string) => actorRepository.deleteActorItem(actorId, itemId),
        resolveUrl: (url?: string) => client.resolveUrl(url || ''),
        getChatLog: (limit: number) => client.getChatLog(limit),
        createChatMessage: (data: Record<string, unknown>) => chatMessageRepository.send(data),
        fetchByUuid: (uuid: string) => client.fetchByUuid(uuid),
        getAllCompendiumIndices: () => client.getAllCompendiumIndices(),
        getSharedContent: () => client.getSharedContent?.() || null,
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
