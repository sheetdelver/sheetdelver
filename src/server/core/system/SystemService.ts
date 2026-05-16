import { EventEmitter } from 'node:events';
import { CoreSocket } from '../foundry/sockets/CoreSocket';
import { FoundryConfig } from '../foundry/types';
import { hasDiscoveryConfig, hasInitialize } from '@modules/registry/types';
import { logger } from '@shared/utils/logger';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { getAdapter, getRegisteredModules } from '@modules/registry/server';
import { discoveryService } from '../foundry/DiscoveryService';
import { CompendiumCache } from '../foundry/compendium-cache';
import { clearDocumentCache, seedDocumentCache } from '../documents/primary/PrimaryDocumentCacheCoordinator';
import { actorStore } from '../documents/primary/actors/ActorStore';
import { chatMessageStore } from '../documents/primary/chat-messages/ChatMessageStore';
import { folderStore } from '../documents/primary/folders/FolderStore';
import { journalStore } from '../documents/primary/journals/JournalStore';
import { userStore } from '../documents/primary/users/UserStore';
import type { DocumentChangedEvent, DocumentListInvalidatedEvent } from '../documents/primary/base/PrimaryDocumentStore';

/**
 * SystemService: The authoritative provider for the Backend "World Context".
 * Owns the SystemSocket (service account) and handles all world-wide logic.
 */
export class SystemService extends EventEmitter {
    private static instance: SystemService;
    private config: FoundryConfig | null = null;
    private systemClient: CoreSocket | null = null;
    private initialized: boolean = false;
    private bootstrapPromise: Promise<void> | null = null;

    private constructor() {
        super();
        // ActorStore is the single actor-change source; SystemService bridges it onto
        // the existing realtime event name so browser/module subscriptions stay stable.
        // The wire-event rename (actorUpdate → actorChanged) is deferred per ADR-0012.
        actorStore.on('documentChanged', (event: DocumentChangedEvent) => {
            this.systemClient?.emit('actorUpdate', { actorId: event.id, action: event.action });
        });
        actorStore.on('documentListInvalidated', (event: DocumentListInvalidatedEvent) => {
            this.systemClient?.emit('actorListInvalidated', {
                reason: event.reason,
                actorId: event.documentId,
                targetUserIds: event.targetUserIds,
            });
        });

        // ChatMessageStore is the chat-event source going forward. Per ADR-0012,
        // ChatMessage uses the new event names — wire-level chatUpdate is removed.
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
        // user-document changes get their own event surface, separate from the
        // broader systemStatusUpdate broadcast (which stays for connection /
        // world-status transitions and presence shifts).
        userStore.on('documentChanged', (event: DocumentChangedEvent) => {
            this.systemClient?.emit('userChanged', { userId: event.id, action: event.action });
        });
        userStore.on('documentListInvalidated', (event: DocumentListInvalidatedEvent) => {
            this.systemClient?.emit('userListInvalidated', {
                reason: event.reason,
                userId: event.documentId,
                targetUserIds: event.targetUserIds,
            });
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
        
        this.systemClient = new CoreSocket(config);
        
        // Setup world lifecycle monitoring
        this.systemClient.on('connect', () => this.handleConnect());
        this.systemClient.on('disconnect', () => this.handleDisconnect());

        await this.systemClient.connect().catch(err => {
            logger.error(`SystemService | Core socket initial connection failed: ${err.message}`);
        });
    }

    private handleConnect() {
        const state = this.systemClient?.worldState;
        logger.info(`SystemService | System Client connected. World State: ${state}`);
        
        this.emit('world:connected', { state });

        if (state === 'active') {
            this.bootstrap().catch(err => {
                logger.error(`SystemService | Bootstrap failed: ${err.message}`);
            });
        }
    }

    private handleDisconnect() {
        logger.info('SystemService | System Client disconnected.');
        this.emit('world:disconnected');
        this.initialized = false;
        this.bootstrapPromise = null;
        clearDocumentCache('world-disconnected');
    }

    /**
     * Holistic bootstrap sequence to ensure world is ready (Caches, Adapters, Discovery).
     */
    public async bootstrap(): Promise<void> {
        if (!this.systemClient) throw new Error("SystemService not initialized");
        if (this.initialized) return;
        if (this.bootstrapPromise) return this.bootstrapPromise;

        const client = this.systemClient;

        return this.bootstrapPromise = (async () => {
            logger.info('SystemService | Beginning world bootstrap...');
            
            try {
                // 1. Compendium Cache Warmup
                const cache = CompendiumCache.getInstance();
                await cache.initialize(client);

                // 2. Declarative Discovery (Sharding)
                const sysInfo = await client.getSystem();
                if (sysInfo?.id) {
                    const sysId = sysInfo.id.toLowerCase();
                    const registered = getRegisteredModules({ includeExperimental: true });
                    const moduleInfo = registered.find(m => m.id.toLowerCase() === sysId);
                    const adapter = await getAdapter(sysId);

                    let discoveryConfig = moduleInfo?.discovery;

                    // Fallback to adapter hook
                    if (!discoveryConfig && hasDiscoveryConfig(adapter)) {
                        discoveryConfig = adapter.getDiscoveryConfig();
                    }

                    if (discoveryConfig) {
                        logger.info(`SystemService | Running discovery sync for ${sysId}...`);
                        await discoveryService.sync(client, sysId, discoveryConfig);
                    }

                    // 3. Required primary document cache seed
                    // Routes are not considered ready until world actors are cached.
                    await seedDocumentCache(client);

                    // 4. Adapter Initialization
                    if (hasInitialize(adapter)) {
                        logger.info(`SystemService | Initializing adapter for ${sysInfo.id}...`);
                        const { createModuleContext } = await import('@server/shared/utils/createModuleContext');
                        const context = await createModuleContext(sysInfo.id.toLowerCase());
                        await adapter.initialize(context);
                    }

                    this.emit('world:ready', { systemId: sysInfo.id });
                }

                this.initialized = true;
                this.bootstrapPromise = null;
                logger.info('SystemService | World bootstrap complete.');
            } catch (err: unknown) {
                logger.error(`SystemService | Bootstrap encountered error: ${getErrorMessage(err)}`);
                this.bootstrapPromise = null;
                throw err;
            }
        })();
    }

    public getSystemClient(): CoreSocket {
        if (!this.systemClient) throw new Error("SystemService not initialized");
        return this.systemClient;
    }

    public isReady(): boolean {
        return this.initialized;
    }

    public async getAdapter(): Promise<any> {
        if (!this.systemClient) return null;
        const sysInfo = await this.systemClient.getSystem();
        if (!sysInfo?.id) return null;
        return getAdapter(sysInfo.id.toLowerCase());
    }
}

export const systemService = SystemService.getInstance();
