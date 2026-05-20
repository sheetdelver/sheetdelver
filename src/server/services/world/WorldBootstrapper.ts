import { getAdapter, getRegisteredModules } from '@modules/registry/server';
import {
    hasDiscoveryConfig,
    hasInitialize,
    type SystemAdapter,
    type SystemModuleInfo,
} from '@modules/registry/types';
import { CompendiumCache, compendiumStore } from '@server/core/compendium';
import type { CompendiumDiscoveryResult } from '@server/core/compendium/types';
import { seedDocumentCache } from '@server/core/documents/primary/PrimaryDocumentCacheCoordinator';
import type { CoreSocket } from '@server/core/foundry/sockets/CoreSocket';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import {
    CompendiumService,
    discoveryService,
    type CompendiumTransport,
    type DiscoveryPackReader,
    type DiscoverySyncClient,
} from '@server/services/compendium';
import { logger } from '@shared/utils/logger';
import type { DiscoveryConfig, ModuleContext } from '@shared/sdk';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';

export interface WorldBootstrapperDeps {
    loadAdapter?: (systemId: string) => Promise<SystemAdapter | null>;
    createCompendiumService?: (transport: WorldBootstrapTransport) => BootstrapCompendiumService;
    rebuildCompendiumCache?: (indices: CompendiumDiscoveryResult[]) => void;
    getSystem?: () => { id?: string | null } | null;
    getRegisteredModules?: () => SystemModuleInfo[];
    syncDiscovery?: (
        transport: WorldBootstrapTransport,
        systemId: string,
        config: DiscoveryConfig,
        compendiumService: BootstrapCompendiumService,
    ) => Promise<void>;
    seedDocuments?: (transport: WorldBootstrapTransport) => Promise<void>;
    createModuleContext?: (systemId: string) => Promise<ModuleContext>;
}

export type WorldBootstrapTransport = CompendiumTransport & DiscoverySyncClient;

export type BootstrapCompendiumService = DiscoveryPackReader & {
    discoverIndices(): Promise<CompendiumDiscoveryResult[]>;
};

export interface WorldBootstrapReadyEvent {
    systemId: string;
}

export interface WorldBootstrapResult {
    ready: boolean;
    systemId?: string;
}

export interface WorldBootstrapOptions {
    onReady?: (event: WorldBootstrapReadyEvent) => void | Promise<void>;
}

/**
 * Owns world-level runtime services that are derived from the active system.
 *
 * ADR-0017 Phase 4 makes this the owner of application bootstrap ordering.
 * SystemService remains the public event/readiness facade, while this service
 * owns the idempotent bootstrap run and active-adapter lifecycle.
 */
export class WorldBootstrapper {
    private readonly loadAdapter: (systemId: string) => Promise<SystemAdapter | null>;
    private readonly createCompendiumService: (transport: WorldBootstrapTransport) => BootstrapCompendiumService;
    private readonly rebuildCompendiumCache: (indices: CompendiumDiscoveryResult[]) => void;
    private readonly getSystem: () => { id?: string | null } | null;
    private readonly getRegisteredModules: () => SystemModuleInfo[];
    private readonly syncDiscovery: (
        transport: WorldBootstrapTransport,
        systemId: string,
        config: DiscoveryConfig,
        compendiumService: BootstrapCompendiumService,
    ) => Promise<void>;
    private readonly seedDocuments: (transport: WorldBootstrapTransport) => Promise<void>;
    private readonly createModuleContext: (systemId: string) => Promise<ModuleContext>;
    private activeSystemId: string | null = null;
    private activeAdapter: SystemAdapter | null = null;
    private ready = false;
    private bootstrapPromise: Promise<WorldBootstrapResult> | null = null;

    public constructor(deps: WorldBootstrapperDeps = {}) {
        this.loadAdapter = deps.loadAdapter ?? ((systemId) => getAdapter(systemId));
        this.createCompendiumService = deps.createCompendiumService ?? ((transport) => new CompendiumService({
            transport,
            store: compendiumStore,
            getGameDataSnapshot: () => worldStateStore.getGameDataSnapshot(),
        }));
        this.rebuildCompendiumCache = deps.rebuildCompendiumCache ?? ((indices) => {
            CompendiumCache.getInstance().rebuildFromPacks(indices);
        });
        this.getSystem = deps.getSystem ?? (() => worldStateStore.getSystem());
        this.getRegisteredModules = deps.getRegisteredModules ?? (() => getRegisteredModules({ includeExperimental: true }));
        this.syncDiscovery = deps.syncDiscovery ?? (async (transport, systemId, config, compendiumService) => {
            await discoveryService.sync(transport, systemId, config, compendiumService);
        });
        this.seedDocuments = deps.seedDocuments ?? ((transport) => seedDocumentCache(transport as CoreSocket));
        this.createModuleContext = deps.createModuleContext ?? (async (systemId) => {
            const { createModuleContext } = await import('@server/shared/utils/createModuleContext');
            return createModuleContext(systemId);
        });
    }

    public bootstrap(transport: WorldBootstrapTransport, options: WorldBootstrapOptions = {}): Promise<WorldBootstrapResult> {
        if (this.ready) {
            return Promise.resolve({
                ready: true,
                systemId: this.getSystem()?.id || this.activeSystemId || undefined,
            });
        }

        if (this.bootstrapPromise) return this.bootstrapPromise;

        // Connect, status, and retry paths may all ask for bootstrap. The first
        // caller owns the run; everyone else observes the same in-flight promise.
        this.bootstrapPromise = this.runBootstrap(transport, options).catch((error) => {
            this.bootstrapPromise = null;
            throw error;
        });

        return this.bootstrapPromise;
    }

    public isReady(): boolean {
        return this.ready;
    }

    public reset(reason = 'world-bootstrap-reset'): void {
        this.ready = false;
        this.bootstrapPromise = null;
        this.clearActiveAdapter(reason);
    }

    private async runBootstrap(
        transport: WorldBootstrapTransport,
        options: WorldBootstrapOptions,
    ): Promise<WorldBootstrapResult> {
        logger.info('WorldBootstrapper | Beginning world bootstrap...');

        try {
            // Pathway A compendium discovery warms Store-backed pack indices,
            // then rebuilds the legacy UUID-name cache from those results.
            const compendiumService = this.createCompendiumService(transport);
            const compendiumIndices = await compendiumService.discoverIndices();
            this.rebuildCompendiumCache(compendiumIndices);

            const sysInfo = this.getSystem();
            if (sysInfo?.id) {
                const sysId = sysInfo.id.toLowerCase();
                const registered = this.getRegisteredModules();
                const moduleInfo = registered.find(module => module.id.toLowerCase() === sysId);
                const adapter = await this.loadActiveAdapter(sysId);

                let discoveryConfig = moduleInfo?.discovery;
                if (!discoveryConfig && hasDiscoveryConfig(adapter)) {
                    discoveryConfig = adapter.getDiscoveryConfig();
                }

                if (discoveryConfig) {
                    logger.info(`WorldBootstrapper | Running discovery sync for ${sysId}...`);
                    await this.syncDiscovery(transport, sysId, discoveryConfig, compendiumService);
                }

                // Routes are not ready until every registered primary-document
                // Store has completed its bootstrap seed.
                await this.seedDocuments(transport);

                if (hasInitialize(adapter)) {
                    logger.info(`WorldBootstrapper | Initializing adapter for ${sysInfo.id}...`);
                    const context = await this.createModuleContext(sysId);
                    await adapter.initialize(context);
                }

                await options.onReady?.({ systemId: sysInfo.id });
                this.ready = true;
                this.bootstrapPromise = null;
                logger.info('WorldBootstrapper | World bootstrap complete.');
                return { ready: true, systemId: sysInfo.id };
            }

            this.ready = true;
            this.bootstrapPromise = null;
            logger.info('WorldBootstrapper | World bootstrap complete.');
            return { ready: true };
        } catch (error) {
            logger.error(`WorldBootstrapper | Bootstrap encountered error: ${getErrorMessage(error)}`);
            this.ready = false;
            this.bootstrapPromise = null;
            throw error;
        }
    }

    public async loadActiveAdapter(systemId: string): Promise<SystemAdapter | null> {
        const normalizedSystemId = systemId.trim().toLowerCase();
        if (!normalizedSystemId) {
            this.clearActiveAdapter('empty-system-id');
            return null;
        }

        if (this.activeSystemId === normalizedSystemId && this.activeAdapter) {
            return this.activeAdapter;
        }

        try {
            const adapter = await this.loadAdapter(normalizedSystemId);
            this.activeSystemId = normalizedSystemId;
            this.activeAdapter = adapter;

            if (adapter) {
                logger.info(`WorldBootstrapper | Loaded active adapter: ${normalizedSystemId}`);
            } else {
                logger.warn(`WorldBootstrapper | No active adapter available for ${normalizedSystemId}`);
            }

            return adapter;
        } catch (error) {
            this.activeSystemId = normalizedSystemId;
            this.activeAdapter = null;
            logger.error(`WorldBootstrapper | Failed to load active adapter for ${normalizedSystemId}: ${getErrorMessage(error)}`);
            return null;
        }
    }

    public getActiveAdapter(): SystemAdapter | null {
        return this.activeAdapter;
    }

    public getActiveSystemId(): string | null {
        return this.activeSystemId;
    }

    public clearActiveAdapter(reason = 'clear-active-adapter'): void {
        if (!this.activeSystemId && !this.activeAdapter) return;

        logger.debug(`WorldBootstrapper | Clearing active adapter (${reason})`);
        this.activeSystemId = null;
        this.activeAdapter = null;
    }
}

export const worldBootstrapper = new WorldBootstrapper();
