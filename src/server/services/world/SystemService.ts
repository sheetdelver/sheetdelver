import { EventEmitter } from 'node:events';
import { CoreSocket } from '@server/core/foundry/sockets/CoreSocket';
import { FoundryConfig } from '@server/core/foundry/types';
import type { SystemAdapter } from '@modules/registry/types';
import { logger } from '@shared/utils/logger';
import { worldBootstrapper } from './WorldBootstrapper';
import { foundryEventIngress } from './FoundryEventIngress';
import { WorldTransportController } from './WorldTransportController';
import { compendiumStore } from '@server/core/compendium';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { worldLifecycleStore } from '@server/core/world/WorldLifecycleStore';
import { SetupManager } from '@server/core/world/SetupManager';
import { primaryDocumentCacheCoordinator } from '@server/core/documents/primary/PrimaryDocumentCacheCoordinator';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { chatMessageStore } from '@server/core/documents/primary/chat-messages/ChatMessageStore';
import { combatStore } from '@server/core/documents/primary/combats/CombatStore';
import { folderStore } from '@server/core/documents/primary/folders/FolderStore';
import { cardsStore } from '@server/core/documents/primary/cards/CardsStore';
import { itemStore } from '@server/core/documents/primary/items/ItemStore';
import { journalStore } from '@server/core/documents/primary/journals/JournalStore';
import { macroStore } from '@server/core/documents/primary/macros/MacroStore';
import { playlistStore } from '@server/core/documents/primary/playlists/PlaylistStore';
import { rollTableStore } from '@server/core/documents/primary/roll-tables/RollTableStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import type { DocumentChangedEvent, DocumentListInvalidatedEvent } from '@server/core/documents/primary/base/PrimaryDocumentStore';

/**
 * SystemService: The authoritative provider for the Backend "World Context".
 * Owns the SystemSocket (service account) and handles all world-wide logic.
 */
export class SystemService extends EventEmitter {
    private static instance: SystemService;
    private config: FoundryConfig | null = null;
    private systemClient: CoreSocket | null = null;
    private worldTransportController: WorldTransportController | null = null;
    private detachFoundryEventIngress: (() => void) | null = null;

    private constructor() {
        super();
        // ActorStore is the single actor-change source; SystemService bridges it onto
        // the realtime wire event. Phase 7 closure renamed the legacy `actorUpdate`
        // wire event to `actorChanged` so every primary doc type uses uniform
        // `<type>Changed` / `<type>ListInvalidated` names.
        actorStore.on('documentChanged', (event: DocumentChangedEvent) => {
            this.systemClient?.emit('actorChanged', { actorId: event.id, action: event.action });
        });
        actorStore.on('documentListInvalidated', (event: DocumentListInvalidatedEvent) => {
            this.systemClient?.emit('actorListInvalidated', {
                reason: event.reason,
                actorId: event.documentId,
                targetUserIds: event.targetUserIds,
            });
        });

        // ChatMessageStore is the chat-event source going forward. Per ADR-0012,
        // ChatMessage uses the new event names.
        chatMessageStore.on('documentChanged', (event: DocumentChangedEvent) => {
            this.systemClient?.emit('chatMessageChanged', { messageId: event.id, action: event.action });
        });
        chatMessageStore.on('documentListInvalidated', (event: DocumentListInvalidatedEvent) => {
            this.systemClient?.emit('chatMessageListInvalidated', {
                reason: event.reason,
                messageId: event.documentId,
                targetUserIds: event.targetUserIds,
            });
        });

        // FolderStore is the Folder document-event source. Folder events are
        // document-type generic; contained Actor/Item/Journal documents emit
        // through their own Stores.
        folderStore.on('documentChanged', (event: DocumentChangedEvent) => {
            this.systemClient?.emit('folderChanged', { folderId: event.id, action: event.action });
        });
        folderStore.on('documentListInvalidated', (event: DocumentListInvalidatedEvent) => {
            this.systemClient?.emit('folderListInvalidated', {
                reason: event.reason,
                folderId: event.documentId,
                targetUserIds: event.targetUserIds,
            });
        });

        // UserStore is the User-document-event source. Per ADR-0011 Phase 2,
        // user-document changes get their own event surface; they also request
        // a systemStatus refresh because the dashboard and login dropdown derive
        // their roster view from the full status payload.
        userStore.on('documentChanged', (event: DocumentChangedEvent) => {
            this.systemClient?.emit('userChanged', { userId: event.id, action: event.action });
            this.emit('system:status-update');
        });
        userStore.on('documentListInvalidated', (event: DocumentListInvalidatedEvent) => {
            this.systemClient?.emit('userListInvalidated', {
                reason: event.reason,
                userId: event.documentId,
                targetUserIds: event.targetUserIds,
            });
            this.emit('system:status-update');
        });

        // JournalStore is the JournalEntry document-event source. Embedded
        // JournalEntryPage mutations are reported as `update` events on the
        // parent entry — gateway consumers refetch the entry detail to pick
        // up the new page state.
        journalStore.on('documentChanged', (event: DocumentChangedEvent) => {
            this.systemClient?.emit('journalChanged', { journalId: event.id, action: event.action });
        });
        journalStore.on('documentListInvalidated', (event: DocumentListInvalidatedEvent) => {
            this.systemClient?.emit('journalListInvalidated', {
                reason: event.reason,
                journalId: event.documentId,
                targetUserIds: event.targetUserIds,
            });
        });

        // CombatStore is the Combat document-event source (Phase 5). Embedded
        // Combatant mutations are reported as `update` events on the parent
        // combat — gateway consumers refetch combat detail to pick up the new
        // combatant state. Combat visibility crossings driven by actor ownership
        // changes propagate via CombatStore.bindActorVisibilityBridge; embedded
        // combatant actor-id / hidden changes can also invalidate combat lists.
        combatStore.on('documentChanged', (event: DocumentChangedEvent) => {
            this.systemClient?.emit('combatChanged', { combatId: event.id, action: event.action });
        });
        combatStore.on('documentListInvalidated', (event: DocumentListInvalidatedEvent) => {
            this.systemClient?.emit('combatListInvalidated', {
                reason: event.reason,
                combatId: event.documentId,
                targetUserIds: event.targetUserIds,
            });
        });

        // ItemStore is the world Item document-event source (Phase 6). Embedded
        // ActiveEffect mutations on world Items are reported as `update` events
        // on the parent item. No browser context subscribes today — the bridge
        // exists for future module-SDK consumers and to keep the wire-event
        // surface uniform across Stores.
        itemStore.on('documentChanged', (event: DocumentChangedEvent) => {
            this.systemClient?.emit('itemChanged', { itemId: event.id, action: event.action });
        });
        itemStore.on('documentListInvalidated', (event: DocumentListInvalidatedEvent) => {
            this.systemClient?.emit('itemListInvalidated', {
                reason: event.reason,
                itemId: event.documentId,
                targetUserIds: event.targetUserIds,
            });
        });

        // RollTableStore is the RollTable document-event source (Phase 7).
        // Embedded RollTableResult mutations (e.g. `drawn` flips) are reported
        // as `update` events on the parent table. No in-tree consumer today.
        rollTableStore.on('documentChanged', (event: DocumentChangedEvent) => {
            this.systemClient?.emit('rollTableChanged', { rollTableId: event.id, action: event.action });
        });
        rollTableStore.on('documentListInvalidated', (event: DocumentListInvalidatedEvent) => {
            this.systemClient?.emit('rollTableListInvalidated', {
                reason: event.reason,
                rollTableId: event.documentId,
                targetUserIds: event.targetUserIds,
            });
        });

        // MacroStore is the Macro document-event source (Phase 7). No embedded
        // children. No in-tree consumer today.
        macroStore.on('documentChanged', (event: DocumentChangedEvent) => {
            this.systemClient?.emit('macroChanged', { macroId: event.id, action: event.action });
        });
        macroStore.on('documentListInvalidated', (event: DocumentListInvalidatedEvent) => {
            this.systemClient?.emit('macroListInvalidated', {
                reason: event.reason,
                macroId: event.documentId,
                targetUserIds: event.targetUserIds,
            });
        });

        // PlaylistStore is the Playlist document-event source (Phase 7).
        // Embedded PlaylistSound mutations (`playing`, `pausedTime`, `repeat`)
        // are reported as `update` events on the parent playlist. No in-tree
        // consumer today.
        playlistStore.on('documentChanged', (event: DocumentChangedEvent) => {
            this.systemClient?.emit('playlistChanged', { playlistId: event.id, action: event.action });
        });
        playlistStore.on('documentListInvalidated', (event: DocumentListInvalidatedEvent) => {
            this.systemClient?.emit('playlistListInvalidated', {
                reason: event.reason,
                playlistId: event.documentId,
                targetUserIds: event.targetUserIds,
            });
        });

        // CardsStore is the Cards document-event source (Phase 7). Embedded
        // Card mutations are reported as `update` events on the parent Cards
        // doc. Cross-Cards-doc transfers (Cards#pass) arrive as paired events
        // on both parents — each leg fires its own `cardsChanged`. No in-tree
        // consumer today.
        cardsStore.on('documentChanged', (event: DocumentChangedEvent) => {
            this.systemClient?.emit('cardsChanged', { cardsId: event.id, action: event.action });
        });
        cardsStore.on('documentListInvalidated', (event: DocumentListInvalidatedEvent) => {
            this.systemClient?.emit('cardsListInvalidated', {
                reason: event.reason,
                cardsId: event.documentId,
                targetUserIds: event.targetUserIds,
            });
        });

        // Phase 2 lifecycle Store bridge. Consumers still listen to
        // SystemService events; the state source is no longer CoreSocket.
        worldLifecycleStore.on('transition', () => {
            this.emit('system:status-update');
        });
    }

    public static getInstance(): SystemService {
        if (!SystemService.instance) {
            SystemService.instance = new SystemService();
        }
        return SystemService.instance;
    }

    /**
     * Initializes the system socket and begins monitoring for world changes.
     */
    public async initialize(config: FoundryConfig): Promise<void> {
        if (this.systemClient) return;

        this.config = config;
        logger.info('SystemService | Initializing Core system socket...');
        await this.loadInitialSetupCache();

        this.systemClient = new CoreSocket(config);
        this.detachFoundryEventIngress?.();
        this.detachFoundryEventIngress = foundryEventIngress.attach(this.systemClient, {
            onStatusUpdate: () => this.emit('system:status-update'),
        });
        this.worldTransportController?.dispose();
        this.worldTransportController = new WorldTransportController({
            transport: this.systemClient,
        });

        // Setup world lifecycle monitoring
        this.systemClient.on('connect', () => this.handleConnect());
        this.systemClient.on('disconnect', () => this.handleDisconnect());
        await this.worldTransportController.connect().catch(err => {
            logger.error(`SystemService | Core socket initial connection failed: ${err.message}`);
        });
    }

    private async loadInitialSetupCache(): Promise<void> {
        try {
            const cache = await SetupManager.loadCache();
            worldStateStore.setCachedWorlds(cache);
        } catch (e) {
            logger.warn('SystemService | Failed to load initial setup cache: ' + e);
        }
    }

    private handleConnect() {
        const state = worldLifecycleStore.getState();
        logger.info(`SystemService | System Client connected. World State: ${state}`);
        
        this.emit('world:connected', { state });

        if (state === 'startup' || (state === 'active' && !this.isReady())) {
            this.bootstrap().catch(err => {
                logger.error(`SystemService | Bootstrap failed: ${err.message}`);
            });
        }
    }

    private handleDisconnect() {
        logger.info('SystemService | System Client disconnected.');
        this.emit('world:disconnected');
        primaryDocumentCacheCoordinator.clearAll('world-disconnected');
        // Per ADR-0021, compendiumStore.clear() drops in-memory state only.
        // Persistent shards are reused on reconnect when world identity matches.
        compendiumStore.clear('world-disconnected');
        worldBootstrapper.reset('world-disconnected');
    }

    /**
     * Public bootstrap facade. WorldBootstrapper owns the ordering; SystemService
     * keeps the singleton event surface that the rest of the server already uses.
     */
    public async bootstrap(): Promise<void> {
        if (!this.systemClient) throw new Error("SystemService not initialized");
        await worldBootstrapper.bootstrap(this.systemClient, {
            onReady: ({ systemId }) => {
                this.worldTransportController?.startHeartbeat();
                this.emit('world:ready', { systemId });
            },
        });
    }

    public getSystemClient(): CoreSocket {
        if (!this.systemClient) throw new Error("SystemService not initialized");
        return this.systemClient;
    }

    public getWorldTransportController(): WorldTransportController {
        if (!this.worldTransportController) throw new Error("SystemService not initialized");
        return this.worldTransportController;
    }

    public async launchWorld(worldId: string) {
        return this.getWorldTransportController().launchWorld(worldId);
    }

    public async shutdownWorld() {
        return this.getWorldTransportController().shutdownWorld();
    }

    public async withTransportHeartbeatPaused<T>(operation: () => Promise<T>): Promise<T> {
        return this.getWorldTransportController().withHeartbeatPaused(operation);
    }

    public isReady(): boolean {
        return worldBootstrapper.isReady();
    }

    public getActiveAdapter(): SystemAdapter | null {
        return worldBootstrapper.getActiveAdapter();
    }

    public async getAdapter(systemId?: string): Promise<SystemAdapter | null> {
        if (!this.systemClient) return null;
        // Adapter resolution is service-owned. This method remains as the
        // SystemService facade for routes that need adapter-provided data.
        const requestedSystemId = systemId?.toLowerCase();
        const active = worldBootstrapper.getActiveAdapter();
        if (active && (!requestedSystemId || worldBootstrapper.getActiveSystemId() === requestedSystemId)) {
            return active;
        }

        const resolvedSystemId = systemId || worldStateStore.getSystem()?.id;
        if (!resolvedSystemId) return null;
        return worldBootstrapper.loadActiveAdapter(resolvedSystemId);
    }
}

export const systemService = SystemService.getInstance();
