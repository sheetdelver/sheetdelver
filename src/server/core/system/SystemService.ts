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
        actorStore.onActorStoreEvent((event) => {
            if (event.type === 'actorChanged') {
                this.systemClient?.emit('actorUpdate', { actorId: event.actorId, action: event.action });
            }
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
