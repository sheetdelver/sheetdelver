import type { Server, Socket } from 'socket.io';
import { systemService } from '@server/services/world';
import { logger } from '@shared/utils/logger';
import { engagementService } from '@server/services/world';
import type { FoundryUserConnectionServiceLike, FoundryUserConnectionLike, FoundryDocumentClientLike } from '@server/shared/types/foundry';
import type { PublicStatusPayload, SystemStatusPayload } from '@shared/contracts/status';
import {
    documentAudienceIncludes,
    isDocumentAudience,
} from '@server/core/documents/primary/base/audience';
import { sharedContentStore, type SharedContentChangedEvent } from '@server/core/world/SharedContentStore';
import { readPlayerSessionCookie } from '@server/security/playerSessionCookie';
import { STATUS_ROOMS } from './SystemStatusBroadcaster';

type AppSocket = Socket & {
    userSession?: FoundryUserConnectionLike;
    foundryClient?: FoundryDocumentClientLike;
};

interface AppSocketGatewayDeps {
    io: Server;
    foundryUserConnections: FoundryUserConnectionServiceLike;
    getSystemStatusPayload: () => Promise<SystemStatusPayload>;
    getPublicStatusPayload: () => Promise<PublicStatusPayload>;
    broadcastSystemStatus: () => void | Promise<void>;
}

export function registerAppSocketGateway({
    io,
    foundryUserConnections,
    getSystemStatusPayload,
    getPublicStatusPayload,
    broadcastSystemStatus,
}: AppSocketGatewayDeps): void {

    // Auth middleware: the browser sends its HttpOnly cookie automatically;
    // no reusable credential is exposed through socket.handshake.auth.
    io.use(async (rawSocket, next) => {
        const socket = rawSocket as AppSocket;
        const token = readPlayerSessionCookie(socket.handshake.headers.cookie);
        if (!token) {
            // Guests receive lifecycle availability through the public projection.
            socket.join(STATUS_ROOMS.public);
            return next();
        }

        try {
            const session = await foundryUserConnections.getOrRestoreSession(token);
            const sessionUserId = session?.userId || session?.client.userId;
            if (!session || !sessionUserId) {
                socket.join(STATUS_ROOMS.public);
                return next();
            }
            // Attach session/client to socket for later use
            socket.userSession = session;
            socket.foundryClient = session.client;

            // Join authenticated room for sensitive updates (actors, chat, combat, shared content)
            socket.join(STATUS_ROOMS.authenticated);
            next();
        } catch (err) {
            socket.join(STATUS_ROOMS.public);
            next(); // Degrade to guest
        }
    });

    logger.info('Core Service | Socket.io server initialized with secure middleware');

    // Per-connection lifecycle: initial push, per-user listener attach/detach, disconnect cleanup
    io.on('connection', async (rawSocket) => {
        const socket = rawSocket as AppSocket;
        const clientCount = io.engine.clientsCount;
        logger.debug(`App Socket | Client connected: ${socket.id} (Total: ${clientCount}, Auth: ${socket.rooms.has('authenticated')})`);

        // Browser engagement is application policy. EngagementService emits a
        // return-to-engagement signal consumed by WorldTransportController.
        engagementService.setActiveBrowserCount(clientCount);

        // Initial status uses the same audience split as subsequent broadcasts.
        const payload = socket.rooms.has(STATUS_ROOMS.authenticated)
            ? await getSystemStatusPayload()
            : await getPublicStatusPayload();
        socket.emit('systemStatus', payload);

        // Per ADR-0021, authenticated world-backed listener attachment must wait
        // until SystemService.isReady(). Browser clients during `startup` are
        // status-only — they receive `systemStatus` above but do not subscribe
        // to world-backed fan-out (actorChanged / chatMessageChanged / etc.)
        // until WorldBootstrapper has finished and `world:ready` has fired.
        const foundryClient = socket.foundryClient;

        // Always-on engagement decrement — registered once for both guest and
        // authenticated paths, and runs whether or not world-backed listeners
        // were ever attached. Listener cleanup is a separate disconnect handler
        // registered inside attachWorldBackedListeners.
        socket.on('disconnect', () => {
            const remaining = io.engine.clientsCount;
            logger.debug(`App Socket | Client disconnected: ${socket.id}. Remaining: ${remaining}`);
            engagementService.setActiveBrowserCount(remaining);
        });

        const attachWorldBackedListeners = (foundryClient: FoundryDocumentClientLike) => {
            const sessionIdentity = socket.userSession?.username || socket.userSession?.userId || foundryClient.userId || 'unknown';
            logger.info(`App Socket | Attaching per-user listeners for ${sessionIdentity} (${socket.id})`);

            const getSessionUserId = () => socket.userSession?.userId || foundryClient.userId || null;
            const emitWorldBackedEvent = (event: string, payload: unknown) => {
                if (!systemService.isReady()) return;
                socket.emit(event, payload);
            };
            // Stores calculate audience before state is lost and through their
            // type-specific visibility policy. The gateway fails closed on a
            // missing/malformed audience and strips it from the browser payload.
            const forwardAudienceEvent = (event: string, rawPayload: unknown) => {
                if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
                    logger.warn(`App Socket | Rejected malformed ${event} audience envelope.`);
                    return;
                }
                const data = rawPayload as Record<string, unknown>;
                if (!isDocumentAudience(data.audience)) {
                    logger.warn(`App Socket | Rejected ${event} without a valid audience.`);
                    return;
                }
                if (!documentAudienceIncludes(data.audience, getSessionUserId())) return;
                const { audience: _internalAudience, ...browserPayload } = data;
                emitWorldBackedEvent(event, browserPayload);
            };
            const createAudienceHandler = (event: string) => (...args: unknown[]) => {
                forwardAudienceEvent(event, args[0]);
            };

            const handleCombatChanged = createAudienceHandler('combatChanged');
            const handleCombatListInvalidated = createAudienceHandler('combatListInvalidated');
            const handleActorChanged = createAudienceHandler('actorChanged');
            const handleActorListInvalidated = createAudienceHandler('actorListInvalidated');
            const handleChatMessageChanged = createAudienceHandler('chatMessageChanged');
            const handleChatMessageListInvalidated = createAudienceHandler('chatMessageListInvalidated');
            const handleUserChanged = createAudienceHandler('userChanged');
            const handleUserListInvalidated = createAudienceHandler('userListInvalidated');
            const handleFolderChanged = createAudienceHandler('folderChanged');
            const handleFolderListInvalidated = createAudienceHandler('folderListInvalidated');
            const handleJournalChanged = createAudienceHandler('journalChanged');
            const handleJournalListInvalidated = createAudienceHandler('journalListInvalidated');
            const handleItemChanged = createAudienceHandler('itemChanged');
            const handleItemListInvalidated = createAudienceHandler('itemListInvalidated');
            const handleRollTableChanged = createAudienceHandler('rollTableChanged');
            const handleRollTableListInvalidated = createAudienceHandler('rollTableListInvalidated');
            const handleMacroChanged = createAudienceHandler('macroChanged');
            const handleMacroListInvalidated = createAudienceHandler('macroListInvalidated');
            const handlePlaylistChanged = createAudienceHandler('playlistChanged');
            const handlePlaylistListInvalidated = createAudienceHandler('playlistListInvalidated');
            const handleCardsChanged = createAudienceHandler('cardsChanged');
            const handleCardsListInvalidated = createAudienceHandler('cardsListInvalidated');
            const handleSceneChanged = createAudienceHandler('sceneChanged');
            const handleSceneListInvalidated = createAudienceHandler('sceneListInvalidated');
            const handleSettingChanged = createAudienceHandler('settingChanged');
            const handleSettingListInvalidated = createAudienceHandler('settingListInvalidated');
            // Shared-content fan-out subscribes to SharedContentStore directly.
            // SocketBase writes Foundry wire events into the Store, and the
            // gateway preserves the browser-facing `sharedContentUpdate` event.
            const handleSharedUpdate = (event: SharedContentChangedEvent) => {
                emitWorldBackedEvent('sharedContentUpdate', event.payload ?? { type: null });
            };

            // Store events are bridged through the system client, not per-user
            // sockets. Each Store emits from one canonical source; the gateway
            // applies ownership filtering separately for each browser socket.
            const systemClient = systemService.getSystemClient();
            systemClient.on('actorChanged', handleActorChanged);
            systemClient.on('actorListInvalidated', handleActorListInvalidated);
            systemClient.on('chatMessageChanged', handleChatMessageChanged);
            systemClient.on('chatMessageListInvalidated', handleChatMessageListInvalidated);
            systemClient.on('userChanged', handleUserChanged);
            systemClient.on('userListInvalidated', handleUserListInvalidated);
            systemClient.on('folderChanged', handleFolderChanged);
            systemClient.on('folderListInvalidated', handleFolderListInvalidated);
            systemClient.on('journalChanged', handleJournalChanged);
            systemClient.on('journalListInvalidated', handleJournalListInvalidated);
            systemClient.on('combatChanged', handleCombatChanged);
            systemClient.on('combatListInvalidated', handleCombatListInvalidated);
            systemClient.on('itemChanged', handleItemChanged);
            systemClient.on('itemListInvalidated', handleItemListInvalidated);
            systemClient.on('rollTableChanged', handleRollTableChanged);
            systemClient.on('rollTableListInvalidated', handleRollTableListInvalidated);
            systemClient.on('macroChanged', handleMacroChanged);
            systemClient.on('macroListInvalidated', handleMacroListInvalidated);
            systemClient.on('playlistChanged', handlePlaylistChanged);
            systemClient.on('playlistListInvalidated', handlePlaylistListInvalidated);
            systemClient.on('cardsChanged', handleCardsChanged);
            systemClient.on('cardsListInvalidated', handleCardsListInvalidated);
            systemClient.on('sceneChanged', handleSceneChanged);
            systemClient.on('sceneListInvalidated', handleSceneListInvalidated);
            systemClient.on('settingChanged', handleSettingChanged);
            systemClient.on('settingListInvalidated', handleSettingListInvalidated);
            const unsubscribeSharedContent = sharedContentStore.onSharedContentChanged(handleSharedUpdate);

            const detachWorldBackedListeners = () => {
                systemClient.off('actorChanged', handleActorChanged);
                systemClient.off('actorListInvalidated', handleActorListInvalidated);
                systemClient.off('chatMessageChanged', handleChatMessageChanged);
                systemClient.off('chatMessageListInvalidated', handleChatMessageListInvalidated);
                systemClient.off('userChanged', handleUserChanged);
                systemClient.off('userListInvalidated', handleUserListInvalidated);
                systemClient.off('folderChanged', handleFolderChanged);
                systemClient.off('folderListInvalidated', handleFolderListInvalidated);
                systemClient.off('journalChanged', handleJournalChanged);
                systemClient.off('journalListInvalidated', handleJournalListInvalidated);
                systemClient.off('combatChanged', handleCombatChanged);
                systemClient.off('combatListInvalidated', handleCombatListInvalidated);
                systemClient.off('itemChanged', handleItemChanged);
                systemClient.off('itemListInvalidated', handleItemListInvalidated);
                systemClient.off('rollTableChanged', handleRollTableChanged);
                systemClient.off('rollTableListInvalidated', handleRollTableListInvalidated);
                systemClient.off('macroChanged', handleMacroChanged);
                systemClient.off('macroListInvalidated', handleMacroListInvalidated);
                systemClient.off('playlistChanged', handlePlaylistChanged);
                systemClient.off('playlistListInvalidated', handlePlaylistListInvalidated);
                systemClient.off('cardsChanged', handleCardsChanged);
                systemClient.off('cardsListInvalidated', handleCardsListInvalidated);
                systemClient.off('sceneChanged', handleSceneChanged);
                systemClient.off('sceneListInvalidated', handleSceneListInvalidated);
                systemClient.off('settingChanged', handleSettingChanged);
                systemClient.off('settingListInvalidated', handleSettingListInvalidated);
                unsubscribeSharedContent();
            };

            if (socket.connected) {
                socket.on('disconnect', detachWorldBackedListeners);
            } else {
                // Edge case: socket disconnected between readiness wait and
                // attach — run cleanup immediately so we don't leak listeners.
                detachWorldBackedListeners();
            }
        };

        if (foundryClient) {
            if (systemService.isReady()) {
                attachWorldBackedListeners(foundryClient);
            } else {
                // Defer attach until WorldBootstrapper signals readiness. If
                // the socket disconnects before then, drop the wait so we
                // don't attach world-backed listeners to a dead socket.
                logger.debug(`App Socket | Deferring per-user listeners for ${socket.id} until world:ready`);
                const onWorldReady = () => {
                    socket.off('disconnect', onSocketDisconnect);
                    attachWorldBackedListeners(foundryClient);
                };
                const onSocketDisconnect = () => {
                    systemService.off('world:ready', onWorldReady);
                };
                systemService.once('world:ready', onWorldReady);
                socket.on('disconnect', onSocketDisconnect);
            }
        }
    });
}
