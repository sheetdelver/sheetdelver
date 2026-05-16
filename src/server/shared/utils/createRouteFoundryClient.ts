import type { RollMode } from '@shared/sdk';
import type { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import type { ClientSocket } from '@core/foundry/sockets/ClientSocket';
import type { ChatSendBody } from '@server/shared/types/documents';
import type { RouteFoundryClient } from '@server/shared/types/requestContext';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { ActorRepository } from '@server/core/documents/primary/actors/ActorRepository';
import { ChatMessageRepository } from '@server/core/documents/primary/chat-messages/ChatMessageRepository';
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

            if (type === 'Actor' || type === 'Item' || type === 'ActiveEffect') {
                return actorRepository.dispatchDocument(type, normalizedAction, normalizedOperation, parent);
            }

            if (type === 'ChatMessage') {
                return chatMessageRepository.dispatchDocument(type, normalizedAction, normalizedOperation, parent);
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
        getCombats: () => client.getCombats(),
        getJournals: () => client.getJournals(),
        getFolders: (type: string) => client.getFolders(type),
        dispatchDocumentSocket: (
            type: string,
            action: 'create' | 'get' | 'update' | 'delete',
            payload: Record<string, unknown>
        ) => client.dispatchDocumentSocket(type, action, payload),
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
