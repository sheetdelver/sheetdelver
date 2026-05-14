import type { Server, Socket } from 'socket.io';
import { systemService } from '@core/system/SystemService';
import { logger } from '@shared/utils/logger';
import type { SessionManagerLike, UserSessionLike, FoundryClientLike } from '@server/shared/types/foundry';
import type { SystemStatusPayload } from '@shared/contracts/status';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import {
    DOCUMENT_VISIBILITY,
    FoundryUserRole,
    createDocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import type {
    RealtimeActorUpdatePayload,
    RealtimeChatUpdatePayload,
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

            const handleCombatUpdate = (...args: unknown[]) => {
                const data = (args[0] || {}) as RealtimeCombatUpdatePayload;
                socket.emit('combatUpdate', data);
            };
            const handleChatUpdate = (...args: unknown[]) => {
                const data = (args[0] || {}) as RealtimeChatUpdatePayload;
                socket.emit('chatUpdate', data);
            };
            const handleActorUpdate = (...args: unknown[]) => {
                const data = (args[0] || {}) as RealtimeActorUpdatePayload;
                if (data.action !== 'delete' && data.actorId && socket.userSession?.client.userId) {
                    const user = systemService.getSystemClient().getUser(socket.userSession.client.userId);
                    const subject = createDocumentAccessSubject(
                        socket.userSession.client.userId,
                        user?.role ?? FoundryUserRole.NONE,
                    );
                    if (!subject || !actorStore.canReadActor(data.actorId, subject, DOCUMENT_VISIBILITY.LIST_VISIBLE)) {
                        return;
                    }
                }
                socket.emit('actorUpdate', data);
            };
            const handleSharedUpdate = (...args: unknown[]) => {
                const data = (args[0] || {}) as RealtimeSharedContentPayload;
                socket.emit('sharedContentUpdate', data);
            };

            foundryClient.on('combatUpdate', handleCombatUpdate);
            foundryClient.on('chatUpdate', handleChatUpdate);
            systemService.getSystemClient().on('actorUpdate', handleActorUpdate);
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
                foundryClient.off('chatUpdate', handleChatUpdate);
                systemService.getSystemClient().off('actorUpdate', handleActorUpdate);
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
