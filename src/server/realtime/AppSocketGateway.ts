import type { Server, Socket } from 'socket.io';
import { systemService } from '@core/system/SystemService';
import { logger } from '@shared/utils/logger';
import type { SessionManagerLike, UserSessionLike, FoundryClientLike } from '@server/shared/types/foundry';
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
import type {
    RealtimeActorChangedPayload,
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
                return userStore.createAccessSubject(userId);
            };

            // Combat document fan-out (Phase 5). CombatStore has no per-doc
            // ownership map — visibility is cross-referenced against ActorStore
            // via `combatStore.canReadDocument`. Deletes bypass the gate so a
            // caller who could see the combat learns it's gone.
            const handleCombatChanged = (...args: unknown[]) => {
                const data = (args[0] || {}) as { combatId: string; action: 'create' | 'update' | 'delete' };
                if (data.action !== 'delete' && data.combatId) {
                    const subject = getSubject();
                    if (!subject || !combatStore.canReadDocument(data.combatId, subject, DOCUMENT_VISIBILITY.LIST_VISIBLE)) {
                        return;
                    }
                }
                socket.emit('combatChanged', data);
            };
            const handleCombatListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; combatId?: string; targetUserIds?: string[] };
                const userId = socket.userSession?.client.userId;
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                socket.emit('combatListInvalidated', data);
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
                socket.emit('actorChanged', data);
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
            // User document fan-out. Per ADR-0013 User docs have no per-user
            // ownership map; every authenticated subject sees the roster.
            // `targetUserIds` is honored if present for future-proofing.
            const handleUserChanged = (...args: unknown[]) => {
                const data = (args[0] || {}) as { userId: string; action: 'create' | 'update' | 'delete' };
                socket.emit('userChanged', data);
            };
            const handleUserListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; userId?: string; targetUserIds?: string[] };
                const userId = socket.userSession?.client.userId;
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                socket.emit('userListInvalidated', data);
            };
            // Folder document fan-out. FolderStore emits broadcast-wide today;
            // per-user folder visibility is a Phase 4 concern. Honor targetUserIds
            // if the Store ever populates it.
            const handleFolderChanged = (...args: unknown[]) => {
                const data = (args[0] || {}) as { folderId: string; action: 'create' | 'update' | 'delete' };
                socket.emit('folderChanged', data);
            };
            const handleFolderListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; folderId?: string; targetUserIds?: string[] };
                const userId = socket.userSession?.client.userId;
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                socket.emit('folderListInvalidated', data);
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
                socket.emit('journalChanged', data);
            };
            const handleJournalListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; journalId?: string; targetUserIds?: string[] };
                const userId = socket.userSession?.client.userId;
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                socket.emit('journalListInvalidated', data);
            };
            // World Item document fan-out (Phase 6). ItemStore uses the standard
            // ownership map; `canReadDocument` enforces it per-socket. Deletes
            // bypass so a caller who could see the item learns it's gone.
            // Invalidations honor `targetUserIds`.
            const handleItemChanged = (...args: unknown[]) => {
                const data = (args[0] || {}) as { itemId: string; action: 'create' | 'update' | 'delete' };
                if (data.action !== 'delete' && data.itemId) {
                    const subject = getSubject();
                    if (!subject || !itemStore.canReadDocument(data.itemId, subject, DOCUMENT_VISIBILITY.LIST_VISIBLE)) {
                        return;
                    }
                }
                socket.emit('itemChanged', data);
            };
            const handleItemListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; itemId?: string; targetUserIds?: string[] };
                const userId = socket.userSession?.client.userId;
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                socket.emit('itemListInvalidated', data);
            };
            // RollTable document fan-out (Phase 7). Standard ownership map;
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
                socket.emit('rollTableChanged', data);
            };
            const handleRollTableListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; rollTableId?: string; targetUserIds?: string[] };
                const userId = socket.userSession?.client.userId;
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                socket.emit('rollTableListInvalidated', data);
            };
            // Macro document fan-out (Phase 7). Standard ownership map.
            const handleMacroChanged = (...args: unknown[]) => {
                const data = (args[0] || {}) as { macroId: string; action: 'create' | 'update' | 'delete' };
                if (data.action !== 'delete' && data.macroId) {
                    const subject = getSubject();
                    if (!subject || !macroStore.canReadDocument(data.macroId, subject, DOCUMENT_VISIBILITY.LIST_VISIBLE)) {
                        return;
                    }
                }
                socket.emit('macroChanged', data);
            };
            const handleMacroListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; macroId?: string; targetUserIds?: string[] };
                const userId = socket.userSession?.client.userId;
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                socket.emit('macroListInvalidated', data);
            };
            // Playlist document fan-out (Phase 7). Standard ownership map.
            const handlePlaylistChanged = (...args: unknown[]) => {
                const data = (args[0] || {}) as { playlistId: string; action: 'create' | 'update' | 'delete' };
                if (data.action !== 'delete' && data.playlistId) {
                    const subject = getSubject();
                    if (!subject || !playlistStore.canReadDocument(data.playlistId, subject, DOCUMENT_VISIBILITY.LIST_VISIBLE)) {
                        return;
                    }
                }
                socket.emit('playlistChanged', data);
            };
            const handlePlaylistListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; playlistId?: string; targetUserIds?: string[] };
                const userId = socket.userSession?.client.userId;
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                socket.emit('playlistListInvalidated', data);
            };
            // Cards document fan-out (Phase 7). Standard ownership map.
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
                socket.emit('cardsChanged', data);
            };
            const handleCardsListInvalidated = (...args: unknown[]) => {
                const data = (args[0] || {}) as { reason: string; cardsId?: string; targetUserIds?: string[] };
                const userId = socket.userSession?.client.userId;
                if (data.targetUserIds && (!userId || !data.targetUserIds.includes(userId))) return;
                socket.emit('cardsListInvalidated', data);
            };
            const handleSharedUpdate = (...args: unknown[]) => {
                const data = (args[0] || {}) as RealtimeSharedContentPayload;
                socket.emit('sharedContentUpdate', data);
            };

            // Store events are bridged through the system client, not per-user
            // sockets — per ADR-0012 each Store's events fan out from a single
            // canonical source with ownership filtering applied per socket.
            // Phase 5 moved combatUpdate from foundryClient onto the system
            // client as combatChanged / combatListInvalidated.
            systemService.getSystemClient().on('actorChanged', handleActorChanged);
            systemService.getSystemClient().on('chatMessageChanged', handleChatMessageChanged);
            systemService.getSystemClient().on('chatMessageListInvalidated', handleChatMessageListInvalidated);
            systemService.getSystemClient().on('userChanged', handleUserChanged);
            systemService.getSystemClient().on('userListInvalidated', handleUserListInvalidated);
            systemService.getSystemClient().on('folderChanged', handleFolderChanged);
            systemService.getSystemClient().on('folderListInvalidated', handleFolderListInvalidated);
            systemService.getSystemClient().on('journalChanged', handleJournalChanged);
            systemService.getSystemClient().on('journalListInvalidated', handleJournalListInvalidated);
            systemService.getSystemClient().on('combatChanged', handleCombatChanged);
            systemService.getSystemClient().on('combatListInvalidated', handleCombatListInvalidated);
            systemService.getSystemClient().on('itemChanged', handleItemChanged);
            systemService.getSystemClient().on('itemListInvalidated', handleItemListInvalidated);
            systemService.getSystemClient().on('rollTableChanged', handleRollTableChanged);
            systemService.getSystemClient().on('rollTableListInvalidated', handleRollTableListInvalidated);
            systemService.getSystemClient().on('macroChanged', handleMacroChanged);
            systemService.getSystemClient().on('macroListInvalidated', handleMacroListInvalidated);
            systemService.getSystemClient().on('playlistChanged', handlePlaylistChanged);
            systemService.getSystemClient().on('playlistListInvalidated', handlePlaylistListInvalidated);
            systemService.getSystemClient().on('cardsChanged', handleCardsChanged);
            systemService.getSystemClient().on('cardsListInvalidated', handleCardsListInvalidated);
            foundryClient.on('sharedContentUpdate', handleSharedUpdate);

            // Per-user relays retained only for route-client lifecycle/shared-content events.
            // User presence/status is broadcast once from the system client path.
            foundryClient.on('worldShutdown', broadcastSystemStatus);
            foundryClient.on('worldReload', broadcastSystemStatus);

            socket.on('disconnect', () => {
                const remaining = io.engine.clientsCount;
                logger.debug(`App Socket | Client disconnected: ${socket.id}. Remaining: ${remaining}`);
                systemService.getSystemClient().updateActiveBrowserCount(remaining);

                systemService.getSystemClient().off('actorChanged', handleActorChanged);
                systemService.getSystemClient().off('chatMessageChanged', handleChatMessageChanged);
                systemService.getSystemClient().off('chatMessageListInvalidated', handleChatMessageListInvalidated);
                systemService.getSystemClient().off('userChanged', handleUserChanged);
                systemService.getSystemClient().off('userListInvalidated', handleUserListInvalidated);
                systemService.getSystemClient().off('folderChanged', handleFolderChanged);
                systemService.getSystemClient().off('folderListInvalidated', handleFolderListInvalidated);
                systemService.getSystemClient().off('journalChanged', handleJournalChanged);
                systemService.getSystemClient().off('journalListInvalidated', handleJournalListInvalidated);
                systemService.getSystemClient().off('combatChanged', handleCombatChanged);
                systemService.getSystemClient().off('combatListInvalidated', handleCombatListInvalidated);
                systemService.getSystemClient().off('itemChanged', handleItemChanged);
                systemService.getSystemClient().off('itemListInvalidated', handleItemListInvalidated);
                systemService.getSystemClient().off('rollTableChanged', handleRollTableChanged);
                systemService.getSystemClient().off('rollTableListInvalidated', handleRollTableListInvalidated);
                systemService.getSystemClient().off('macroChanged', handleMacroChanged);
                systemService.getSystemClient().off('macroListInvalidated', handleMacroListInvalidated);
                systemService.getSystemClient().off('playlistChanged', handlePlaylistChanged);
                systemService.getSystemClient().off('playlistListInvalidated', handlePlaylistListInvalidated);
                systemService.getSystemClient().off('cardsChanged', handleCardsChanged);
                systemService.getSystemClient().off('cardsListInvalidated', handleCardsListInvalidated);
                foundryClient.off('sharedContentUpdate', handleSharedUpdate);
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
