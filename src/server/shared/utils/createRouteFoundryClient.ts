import type { RollMode } from '@shared/sdk';
import type { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import type { ClientSocket } from '@core/foundry/sockets/ClientSocket';
import type { ChatSendBody } from '@server/shared/types/documents';
import type { RouteFoundryClient } from '@server/shared/types/requestContext';
import { systemService } from '@core/system/SystemService';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import {
    DOCUMENT_VISIBILITY,
    FoundryUserRole,
    createDocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';

function getUserRole(userId?: string | null): number {
    if (!userId) return FoundryUserRole.GAMEMASTER;
    return systemService.getSystemClient().getUser(userId)?.role ?? FoundryUserRole.NONE;
}

function createBaseRouteFoundryClient(client: CoreSocket | ClientSocket): Omit<RouteFoundryClient, 'sendMessage'> {
    const getSubject = () => createDocumentAccessSubject(client.userId, getUserRole(client.userId));

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
            if (!actorStore.isReady()) return client.getActors();
            const subject = getSubject();
            if (!subject) return actorStore.list();
            return actorStore.listActors({ subject, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE });
        },
        getActor: async (actorId: string) => {
            if (!actorStore.isReady()) return client.getActor(actorId);
            const subject = getSubject();
            if (!subject) return actorStore.get(actorId);
            return actorStore.getActor(actorId, { subject, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE });
        },
        getActorRaw: async (actorId: string) => {
            if (!actorStore.isReady()) return client.getActorRaw(actorId);
            return actorStore.get(actorId);
        },
        createActor: (actorData: Record<string, unknown>) => client.createActor(actorData),
        deleteActor: (actorId: string) => client.deleteActor(actorId),
        updateActor: (actorId: string, payload: Record<string, unknown>) => client.updateActor(actorId, payload),
        dispatchDocument: (
            type: string,
            action: string,
            operation?: unknown,
            parent?: { type: string; id: string }
        ) => client.dispatchDocument(type, action, operation, parent),
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
        ) => client.createActorItem(actorId, payload),
        updateActorItem: (actorId: string, payload: Record<string, unknown>) => client.updateActorItem(actorId, payload),
        deleteActorItem: (actorId: string, itemId: string) => client.deleteActorItem(actorId, itemId),
        resolveUrl: (url?: string) => client.resolveUrl(url || ''),
        getChatLog: (limit: number) => client.getChatLog(limit),
        getCombats: () => client.getCombats(),
        getUsers: () => client.getUsers(),
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
    return {
        ...createBaseRouteFoundryClient(client),
        // Core socket sendMessage accepts an explicit userId position, which system routes leave undefined.
        sendMessage: (
            message: string,
            options?: {
                rollMode?: RollMode;
                speaker?: ChatSendBody['speaker'];
                [key: string]: unknown;
            }
        ) => client.sendMessage(message, undefined, options),
    };
}

export function createSessionRouteFoundryClient(client: ClientSocket, username?: string): RouteFoundryClient {
    return {
        ...createBaseRouteFoundryClient(client),
        username,
        // Client socket already binds the call to a specific authenticated user session.
        sendMessage: (
            message: string,
            options?: {
                rollMode?: RollMode;
                speaker?: ChatSendBody['speaker'];
                [key: string]: unknown;
            }
        ) => client.sendMessage(message, options),
    };
}
