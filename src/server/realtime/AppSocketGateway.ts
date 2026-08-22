import type { Server, Socket } from 'socket.io';
import { systemService } from '@server/services/world';
import { logger } from '@shared/utils/logger';
import { engagementService } from '@server/services/world';
import type { FoundryUserConnectionServiceLike, FoundryUserConnectionLike, FoundryDocumentClientLike } from '@server/shared/types/foundry';
import type { SystemStatusPayload } from '@shared/contracts/status';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { chatMessageStore } from '@server/core/documents/primary/chat-messages/ChatMessageStore';
import { combatStore } from '@server/core/documents/primary/combats/CombatStore';
import { cardsStore } from '@server/core/documents/primary/cards/CardsStore';
import { itemStore } from '@server/core/documents/primary/items/ItemStore';
import { journalStore } from '@server/core/documents/primary/journals/JournalStore';
import { macroStore } from '@server/core/documents/primary/macros/MacroStore';
import { playlistStore } from '@server/core/documents/primary/playlists/PlaylistStore';
import { rollTableStore } from '@server/core/documents/primary/roll-tables/RollTableStore';
import {
    DOCUMENT_VISIBILITY,
} from '@server/core/documents/primary/base/ownership';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { sharedContentStore, type SharedContentChangedEvent } from '@server/core/world/SharedContentStore';
import type { RealtimeActorChangedPayload } from '@shared/contracts/realtime';
import { readPlayerSessionCookie } from '@server/security/playerSessionCookie';

type AppSocket = Socket & {
    userSession?: FoundryUserConnectionLike;
    foundryClient?: FoundryDocumentClientLike;
};

interface AppSocketGatewayDeps {
    io: Server;
    foundryUserConnections: FoundryUserConnectionServiceLike;
    getSystemStatusPayload: () => Promise<SystemStatusPayload>;
    broadcastSystemStatus: () => void | Promise<void>;
}

export function registerAppSocketGateway({
    io,
    foundryUserConnections,
    getSystemStatusPayload,
    broadcastSystemStatus,
}: AppSocketGatewayDeps): void {

    // Auth middleware: the browser sends its HttpOnly cookie automatically;
    // no reusable credential is exposed through socket.handshake.auth.
    io.use(async (rawSocket, next) => {
        const socket = rawSocket as AppSocket;
        const token = readPlayerSessionCookie(socket.handshake.headers.cookie);
        if (!token) {
            // Unauthenticated connection (Guest) - only receives global system status
            return next();
        }

        try {
            const session = await foundryUserConnections.getOrRestoreSession(token);
            const sessionUserId = session?.userId || session?.client.userId;
            if (!session || !sessionUserId) {
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

        // Browser engagement is application policy. EngagementService emits a
        // return-to-engagement signal consumed by WorldTransportController.
        engagementService.setActiveBrowserCount(clientCount);

        // Initial setup for this specific socket connection.
        // Socket clients receive the full payload including users — the login form
        // requires the user list for the player dropdown. The REST /api/status endpoint
        // handles auth-gating separately to prevent unauthenticated API scraping.
        const payload = await getSystemStatusPayload();
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

            // Subject builder closes over the current session; ownership checks
            // are dynamic per event (ADR-0012's fan-out rule).
            const getSessionUserId = () => socket.userSession?.userId || foundryClient.userId || null;
            const getSubject = () => {
                if (!systemService.isReady()) return null;
                return userStore.createAccessSubject(getSessionUserId());
            };
            const emitWorldBackedEvent = (event: string, payload: unknown) => {
                if (!systemService.isReady()) return;
                socket.emit(event, payload);
            };

            // CombatStore has no per-doc ownership map; visibility is
            // cross-referenced against ActorStore. Deletes bypass the gate so
            // a caller who could see the combat learns it's gone.
            const handleCombatChanged = (...args: unknown[]) => {
                const data = (args[0] || {}) as { combatId: string; action: 'create' | 'update' | 'delete' };
                if (data.action !== 'delete' && data.combatId) {
                    const subject = getSubject();
                    if (!subject || !combatStore.canReadDocument(data.combatId, subject, DOCUMENT_VISIBILITY.LIST_VISIBLE)) {
                        return;
                    }
                }
                emitWorldBackedEvent('combatChanged', data);
            };
            const handleCombatListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; combatId?: string; targetUserIds?: string[] };
                const userId = getSessionUserId();
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                emitWorldBackedEvent('combatListInvalidated', data);
            };
            const handleActorChanged = (...args: unknown[]) => {
                const data = (args[0] || {}) as RealtimeActorChangedPayload;
                // Actor updates originate globally from ActorStore, so each socket
                // re-checks current ownership immediately before fan-out.
                if (data.action !== 'delete' && data.actorId) {
                    const subject = getSubject();
                    if (!subject || !actorStore.canReadActor(data.actorId, subject, DOCUMENT_VISIBILITY.LIST_VISIBLE)) {
                        return;
                    }
                }
                emitWorldBackedEvent('actorChanged', data);
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
                emitWorldBackedEvent('chatMessageChanged', data);
            };
            const handleChatMessageListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; messageId?: string; targetUserIds?: string[] };
                const userId = getSessionUserId();
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                emitWorldBackedEvent('chatMessageListInvalidated', data);
            };
            // User document fan-out. Per ADR-0013 User docs have no per-user
            // ownership map; every authenticated subject sees the roster.
            // `targetUserIds` is honored if present for future-proofing.
            const handleUserChanged = (...args: unknown[]) => {
                const data = (args[0] || {}) as { userId: string; action: 'create' | 'update' | 'delete' };
                emitWorldBackedEvent('userChanged', data);
            };
            const handleUserListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; userId?: string; targetUserIds?: string[] };
                const userId = getSessionUserId();
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                emitWorldBackedEvent('userListInvalidated', data);
            };
            // Folder document fan-out. FolderStore emits broadcast-wide today;
            // honor targetUserIds if the Store ever emits a narrower target.
            const handleFolderChanged = (...args: unknown[]) => {
                const data = (args[0] || {}) as { folderId: string; action: 'create' | 'update' | 'delete' };
                emitWorldBackedEvent('folderChanged', data);
            };
            const handleFolderListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; folderId?: string; targetUserIds?: string[] };
                const userId = getSessionUserId();
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                emitWorldBackedEvent('folderListInvalidated', data);
            };
            // Journal document fan-out. JournalEntry carries a standard per-user
            // ownership map, so per-document changes get a Store-side ownership
            // gate; deletes bypass (a caller who could see the entry should know
            // it's gone). Invalidations honor `targetUserIds`.
            const handleJournalChanged = (...args: unknown[]) => {
                const data = (args[0] || {}) as { journalId: string; action: 'create' | 'update' | 'delete' };
                if (data.action !== 'delete' && data.journalId) {
                    const subject = getSubject();
                    if (!subject || !journalStore.canReadDocument(data.journalId, subject, DOCUMENT_VISIBILITY.LIST_VISIBLE)) {
                        return;
                    }
                }
                emitWorldBackedEvent('journalChanged', data);
            };
            const handleJournalListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; journalId?: string; targetUserIds?: string[] };
                const userId = getSessionUserId();
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                emitWorldBackedEvent('journalListInvalidated', data);
            };
            // World Item documents use the standard ownership map.
            // `canReadDocument` enforces it per-socket; deletes bypass so a
            // caller who could see the item learns it's gone. Invalidations
            // honor `targetUserIds`.
            const handleItemChanged = (...args: unknown[]) => {
                const data = (args[0] || {}) as { itemId: string; action: 'create' | 'update' | 'delete' };
                if (data.action !== 'delete' && data.itemId) {
                    const subject = getSubject();
                    if (!subject || !itemStore.canReadDocument(data.itemId, subject, DOCUMENT_VISIBILITY.LIST_VISIBLE)) {
                        return;
                    }
                }
                emitWorldBackedEvent('itemChanged', data);
            };
            const handleItemListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; itemId?: string; targetUserIds?: string[] };
                const userId = getSessionUserId();
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                emitWorldBackedEvent('itemListInvalidated', data);
            };
            // RollTable documents use the standard ownership map;
            // `canReadDocument` enforces per-socket. Deletes bypass so a
            // caller who could see the table learns it's gone.
            const handleRollTableChanged = (...args: unknown[]) => {
                const data = (args[0] || {}) as { rollTableId: string; action: 'create' | 'update' | 'delete' };
                if (data.action !== 'delete' && data.rollTableId) {
                    const subject = getSubject();
                    if (!subject || !rollTableStore.canReadDocument(data.rollTableId, subject, DOCUMENT_VISIBILITY.LIST_VISIBLE)) {
                        return;
                    }
                }
                emitWorldBackedEvent('rollTableChanged', data);
            };
            const handleRollTableListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; rollTableId?: string; targetUserIds?: string[] };
                const userId = getSessionUserId();
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                emitWorldBackedEvent('rollTableListInvalidated', data);
            };
            // Macro documents use the standard ownership map.
            const handleMacroChanged = (...args: unknown[]) => {
                const data = (args[0] || {}) as { macroId: string; action: 'create' | 'update' | 'delete' };
                if (data.action !== 'delete' && data.macroId) {
                    const subject = getSubject();
                    if (!subject || !macroStore.canReadDocument(data.macroId, subject, DOCUMENT_VISIBILITY.LIST_VISIBLE)) {
                        return;
                    }
                }
                emitWorldBackedEvent('macroChanged', data);
            };
            const handleMacroListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; macroId?: string; targetUserIds?: string[] };
                const userId = getSessionUserId();
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                emitWorldBackedEvent('macroListInvalidated', data);
            };
            // Playlist documents use the standard ownership map.
            const handlePlaylistChanged = (...args: unknown[]) => {
                const data = (args[0] || {}) as { playlistId: string; action: 'create' | 'update' | 'delete' };
                if (data.action !== 'delete' && data.playlistId) {
                    const subject = getSubject();
                    if (!subject || !playlistStore.canReadDocument(data.playlistId, subject, DOCUMENT_VISIBILITY.LIST_VISIBLE)) {
                        return;
                    }
                }
                emitWorldBackedEvent('playlistChanged', data);
            };
            const handlePlaylistListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; playlistId?: string; targetUserIds?: string[] };
                const userId = getSessionUserId();
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                emitWorldBackedEvent('playlistListInvalidated', data);
            };
            // Cards documents use the standard ownership map.
            // Cross-Cards-doc transfers (`Cards#pass`) arrive as paired events
            // on both parents — each leg flows through this same gate.
            const handleCardsChanged = (...args: unknown[]) => {
                const data = (args[0] || {}) as { cardsId: string; action: 'create' | 'update' | 'delete' };
                if (data.action !== 'delete' && data.cardsId) {
                    const subject = getSubject();
                    if (!subject || !cardsStore.canReadDocument(data.cardsId, subject, DOCUMENT_VISIBILITY.LIST_VISIBLE)) {
                        return;
                    }
                }
                emitWorldBackedEvent('cardsChanged', data);
            };
            const handleCardsListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; cardsId?: string; targetUserIds?: string[] };
                const userId = getSessionUserId();
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                emitWorldBackedEvent('cardsListInvalidated', data);
            };
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
            const unsubscribeSharedContent = sharedContentStore.onSharedContentChanged(handleSharedUpdate);

            const detachWorldBackedListeners = () => {
                systemClient.off('actorChanged', handleActorChanged);
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
