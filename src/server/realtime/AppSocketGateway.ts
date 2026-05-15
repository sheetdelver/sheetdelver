import type { Server, Socket } from 'socket.io';
import { systemService } from '@core/system/SystemService';
import { logger } from '@shared/utils/logger';
import type { SessionManagerLike, UserSessionLike, FoundryClientLike } from '@server/shared/types/foundry';
import type { SystemStatusPayload } from '@shared/contracts/status';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { chatMessageStore } from '@server/core/documents/primary/chat-messages/ChatMessageStore';
import {
    DOCUMENT_VISIBILITY,
    FoundryUserRole,
    createDocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import type {
    RealtimeActorUpdatePayload,
    RealtimeCombatUpdatePayload,
    RealtimeSharedContentPayload,
} from '@shared/contracts/realtime';

type AppSocket = Socket & {
    userSession?: UserSessionLike;
    foundryClient?: FoundryClientLike;
};

interface AppSocketGatewayDeps {
    io: Server;
    sessionManager: SessionManagerLike;
    getSystemStatusPayload: () => Promise<SystemStatusPayload>;
    broadcastSystemStatus: () => void | Promise<void>;
}

export function registerAppSocketGateway({
    io,
    sessionManager,
    getSystemStatusPayload,
    broadcastSystemStatus,
}: AppSocketGatewayDeps): void {

    // Auth middleware: validate token, restore session, join authenticated room
    io.use(async (rawSocket, next) => {
        const socket = rawSocket as AppSocket;
        const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : undefined;
        if (!token) {
            // Unauthenticated connection (Guest) - only receives global system status
            return next();
        }

        try {
            const session = await sessionManager.getOrRestoreSession(token);
            if (!session || !session.client.userId) {
                // Invalid token, but still allow guest connection
                return next();
            }
            // Attach session/client to socket for later use
            socket.userSession = session;
            socket.foundryClient = session.client;

            // Join authenticated room for sensitive updates (actors, chat, combat, shared content)
            socket.join('authenticated');
            next();
        } catch (err) {
            next(); // Degrade to guest
        }
    });

    logger.info('Core Service | Socket.io server initialized with secure middleware');

    // Per-connection lifecycle: initial push, per-user listener attach/detach, disconnect cleanup
    io.on('connection', async (rawSocket) => {
        const socket = rawSocket as AppSocket;
        const clientCount = io.engine.clientsCount;
        logger.debug(`App Socket | Client connected: ${socket.id} (Total: ${clientCount}, Auth: ${socket.rooms.has('authenticated')})`);

        // Inform SystemService of engagement for adaptive heartbeat
        systemService.getSystemClient().updateActiveBrowserCount(clientCount);

        // Initial setup for this specific socket connection.
        // Socket clients receive the full payload including users — the login form
        // requires the user list for the player dropdown. The REST /api/status endpoint
        // handles auth-gating separately to prevent unauthenticated API scraping.
        const payload = await getSystemStatusPayload();
        socket.emit('systemStatus', payload);

        // Attach listeners to individual foundry client for sensitive/per-user data
        const foundryClient = socket.foundryClient;
        if (foundryClient) {
            logger.info(`App Socket | Attaching per-user listeners for ${foundryClient.username} (${socket.id})`);

            // Subject builder closes over the current session; ownership checks
            // are dynamic per event (ADR-0012's fan-out rule).
            const getSubject = () => {
                const userId = socket.userSession?.client.userId;
                if (!userId) return null;
                const user = systemService.getSystemClient().getUser(userId);
                return createDocumentAccessSubject(userId, user?.role ?? FoundryUserRole.NONE);
            };

            const handleCombatUpdate = (...args: unknown[]) => {
                const data = (args[0] || {}) as RealtimeCombatUpdatePayload;
                socket.emit('combatUpdate', data);
            };
            const handleActorUpdate = (...args: unknown[]) => {
                const data = (args[0] || {}) as RealtimeActorUpdatePayload;
                // Actor updates originate globally from ActorStore, so each socket
                // re-checks current ownership immediately before fan-out.
                if (data.action !== 'delete' && data.actorId) {
                    const subject = getSubject();
                    if (!subject || !actorStore.canReadActor(data.actorId, subject, DOCUMENT_VISIBILITY.LIST_VISIBLE)) {
                        return;
                    }
                }
                socket.emit('actorUpdate', data);
            };
            const handleChatMessageChanged = (...args: unknown[]) => {
                const data = (args[0] || {}) as { messageId: string; action: 'create' | 'update' | 'delete' };
                // Whisper / blind filtering happens at the Store via canReadDocument.
                // Deletes bypass — a user who could see the message should know it's gone.
                if (data.action !== 'delete' && data.messageId) {
                    const subject = getSubject();
                    if (!subject || !chatMessageStore.canReadDocument(data.messageId, subject, DOCUMENT_VISIBILITY.LIST_VISIBLE)) {
                        return;
                    }
                }
                socket.emit('chatMessageChanged', data);
            };
            const handleChatMessageListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; messageId?: string; targetUserIds?: string[] };
                const userId = socket.userSession?.client.userId;
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                socket.emit('chatMessageListInvalidated', data);
            };
            const handleSharedUpdate = (...args: unknown[]) => {
                const data = (args[0] || {}) as RealtimeSharedContentPayload;
                socket.emit('sharedContentUpdate', data);
            };

            foundryClient.on('combatUpdate', handleCombatUpdate);
            // ActorStore + ChatMessageStore events are bridged through the system client,
            // not per-user sockets — per ADR-0012 each Store's events fan out from a single
            // canonical source with ownership filtering applied per socket.
            systemService.getSystemClient().on('actorUpdate', handleActorUpdate);
            systemService.getSystemClient().on('chatMessageChanged', handleChatMessageChanged);
            systemService.getSystemClient().on('chatMessageListInvalidated', handleChatMessageListInvalidated);
            foundryClient.on('sharedContentUpdate', handleSharedUpdate);

            // New relays for world lifecycle and system status
            foundryClient.on('systemStatusUpdate', broadcastSystemStatus);
            foundryClient.on('worldShutdown', broadcastSystemStatus);
            foundryClient.on('worldReload', broadcastSystemStatus);

            socket.on('disconnect', () => {
                const remaining = io.engine.clientsCount;
                logger.debug(`App Socket | Client disconnected: ${socket.id}. Remaining: ${remaining}`);
                systemService.getSystemClient().updateActiveBrowserCount(remaining);

                foundryClient.off('combatUpdate', handleCombatUpdate);
                systemService.getSystemClient().off('actorUpdate', handleActorUpdate);
                systemService.getSystemClient().off('chatMessageChanged', handleChatMessageChanged);
                systemService.getSystemClient().off('chatMessageListInvalidated', handleChatMessageListInvalidated);
                foundryClient.off('sharedContentUpdate', handleSharedUpdate);
                foundryClient.off('systemStatusUpdate', broadcastSystemStatus);
                foundryClient.off('worldShutdown', broadcastSystemStatus);
                foundryClient.off('worldReload', broadcastSystemStatus);
            });
        } else {
            socket.on('disconnect', () => {
                const remaining = io.engine.clientsCount;
                logger.debug(`App Socket | Client disconnected: ${socket.id}. Remaining: ${remaining}`);
                systemService.getSystemClient().updateActiveBrowserCount(remaining);
            });
        }
    });
}
