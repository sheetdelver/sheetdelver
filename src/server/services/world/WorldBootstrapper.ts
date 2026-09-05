import { getAdapter, getRegisteredModules } from '@modules/registry/server';
import {
    hasCompendiumPackConfig,
    hasInitialize,
    type SystemAdapter,
    type SystemModuleInfo,
} from '@modules/registry/types';
import { compendiumStore } from '@server/core/compendium';
import { primaryDocumentCacheCoordinator } from '@server/core/documents/primary/PrimaryDocumentCacheCoordinator';
import { userPresence } from '@server/core/documents/primary/users/UserPresence';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import type { CoreSocket } from '@server/core/foundry/sockets/CoreSocket';
import { sharedContentStore } from '@server/core/world/SharedContentStore';
import { worldLifecycleStore } from '@server/core/world/WorldLifecycleStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import type { GameData, SceneDataCache } from '@server/core/world/types';
import {
    CompendiumService,
    type CompendiumTransport,
} from '@server/services/compendium';
import { logger } from '@shared/utils/logger';
import type { CompendiumPackConfig } from '@shared/sdk';
import type { ModuleRuntime } from '@shared/sdk/runtime';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import type { UserDocument } from '@server/shared/types/users';
import {
    assertFoundryVersionSupported,
    evaluateFoundryVersionCompatibility,
    type FoundryVersionCompatibilityDiagnostic,
    type FoundryVersionCompatibilityResult,
} from './foundryVersionCompatibility';

export interface WorldBootstrapperDeps {
    loadAdapter?: (systemId: string) => Promise<SystemAdapter | null>;
    getBootstrapSnapshot?: (transport: WorldBootstrapTransport) => Promise<WorldBootstrapSnapshot | null>;
    seedWorldSnapshot?: (snapshot: WorldBootstrapSnapshot) => void;
    seedUserSnapshot?: (snapshot: WorldBootstrapSnapshot) => Promise<void>;
    createCompendiumService?: (transport: WorldBootstrapTransport) => CompendiumService;
    seedPackMetadata?: (gameData: GameData) => void;
    getSystem?: () => { id?: string | null } | null;
    getRegisteredModules?: () => SystemModuleInfo[];
    hydrateCompendiumPacks?: (
        systemId: string,
        config: CompendiumPackConfig,
        compendiumService: CompendiumService,
    ) => Promise<void>;
    seedDocuments?: (transport: WorldBootstrapTransport) => Promise<void>;
    createModuleRuntime?: (systemId: string) => Promise<ModuleRuntime>;
    markLifecycleActive?: (systemId?: string) => void;
    markLifecycleClosed?: (reason: string) => void;
    evaluateCompatibility?: typeof evaluateFoundryVersionCompatibility;
    clearWorldRuntimeState?: (reason: string) => void;
    now?: () => number;
}

export interface WorldBootstrapSnapshot {
    gameData: GameData;
    sceneData?: SceneDataCache | null;
}

export type WorldBootstrapTransport = CompendiumTransport & {
    getBootstrapSnapshot?(): Promise<WorldBootstrapSnapshot | null>;
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

class StaleWorldBootstrapError extends Error {
    public constructor() {
        super('World bootstrap was superseded by a runtime teardown');
        this.name = 'StaleWorldBootstrapError';
    }
}

/**
 * Owns world-level runtime services that are derived from the active system.
 *
 * SystemService remains the public event/readiness facade, while this service
 * owns the idempotent bootstrap run and active-adapter lifecycle.
 */
export class WorldBootstrapper {
    private readonly loadAdapter: (systemId: string) => Promise<SystemAdapter | null>;
    private readonly getBootstrapSnapshot: (transport: WorldBootstrapTransport) => Promise<WorldBootstrapSnapshot | null>;
    private readonly seedWorldSnapshot: (snapshot: WorldBootstrapSnapshot) => void;
    private readonly seedUserSnapshot: (snapshot: WorldBootstrapSnapshot) => Promise<void>;
    private readonly createCompendiumService: (transport: WorldBootstrapTransport) => CompendiumService;
    private readonly seedPackMetadata: (gameData: GameData) => void;
    private readonly getSystem: () => { id?: string | null } | null;
    private readonly getRegisteredModules: () => SystemModuleInfo[];
    private readonly hydrateCompendiumPacks: (
        systemId: string,
        config: CompendiumPackConfig,
        compendiumService: CompendiumService,
    ) => Promise<void>;
    private readonly seedDocuments: (transport: WorldBootstrapTransport) => Promise<void>;
    private readonly createModuleRuntime: (systemId: string) => Promise<ModuleRuntime>;
    private readonly markLifecycleActive: (systemId?: string) => void;
    private readonly markLifecycleClosed: (reason: string) => void;
    private readonly evaluateCompatibility: typeof evaluateFoundryVersionCompatibility;
    private readonly clearWorldRuntimeState: (reason: string) => void;
    private readonly now: () => number;
    private activeSystemId: string | null = null;
    private activeAdapter: SystemAdapter | null = null;
    // Retained so the courtesy `adapter.dispose(runtime)` (decision 22) gets the same
    // runtime instance that `initialize` received.
    private activeRuntime: ModuleRuntime | null = null;
    private lastCompatibility: FoundryVersionCompatibilityDiagnostic | null = null;
    private ready = false;
    private bootstrapPromise: Promise<WorldBootstrapResult> | null = null;
    private bootstrapEpoch: number | null = null;
    private runtimeEpoch = 0;

    public constructor(deps: WorldBootstrapperDeps = {}) {
        this.loadAdapter = deps.loadAdapter ?? ((systemId) => getAdapter(systemId));
        this.getBootstrapSnapshot = deps.getBootstrapSnapshot ?? (async (transport) => {
            if (typeof transport.getBootstrapSnapshot !== 'function') return null;

            const snapshot = await transport.getBootstrapSnapshot();
            if (!snapshot?.gameData) {
                throw new Error('World bootstrap snapshot unavailable');
            }

            return snapshot;
        });
        this.seedWorldSnapshot = deps.seedWorldSnapshot ?? ((snapshot) => {
            worldStateStore.seed(snapshot.gameData, { sceneData: snapshot.sceneData ?? null });
        });
        this.seedUserSnapshot = deps.seedUserSnapshot ?? (async (snapshot) => {
            if (Array.isArray(snapshot.gameData.users)) {
                const users: UserDocument[] = snapshot.gameData.users.map((user) => {
                    const { active: _presenceOnly, ...document } = user as UserDocument & { active?: unknown };
                    void _presenceOnly;
                    return document;
                });
                await userStore.seed(async () => users);
            }

            const activeUserIds = Array.isArray(snapshot.gameData.activeUsers)
                ? snapshot.gameData.activeUsers
                : [];
            userPresence.setActiveUsers(activeUserIds);
        });
        this.createCompendiumService = deps.createCompendiumService ?? ((transport) => new CompendiumService({
            transport,
            store: compendiumStore,
        }));
        this.seedPackMetadata = deps.seedPackMetadata ?? ((gameData) => {
            // Passive seed of pack metadata from the bootstrap envelope.
            // Per ADR-0021 this records which packs exist; it does NOT issue
            // any transport calls. Hydration of index rows or documents is
            // module-driven via CompendiumService.hydratePacks(...).
            compendiumStore.seedPackMetadataFromGameData(gameData, 'world-bootstrap');
        });
        this.getSystem = deps.getSystem ?? (() => worldStateStore.getSystem());
        this.getRegisteredModules = deps.getRegisteredModules ?? (() => getRegisteredModules({ includeExperimental: true }));
        this.hydrateCompendiumPacks = deps.hydrateCompendiumPacks ?? (async (systemId, config, compendiumService) => {
            await compendiumService.hydratePacks(systemId, config);
        });
        this.seedDocuments = deps.seedDocuments ?? ((transport) => primaryDocumentCacheCoordinator.seedAll(transport as CoreSocket));
        this.createModuleRuntime = deps.createModuleRuntime ?? (async (systemId) => {
            const { createModuleRuntime } = await import('@server/shared/utils/createModuleRuntime');
            return createModuleRuntime(systemId);
        });
        this.markLifecycleActive = deps.markLifecycleActive ?? ((systemId) => {
            worldLifecycleStore.setState('active', systemId ? `world-bootstrap-ready:${systemId}` : 'world-bootstrap-ready');
        });
        this.markLifecycleClosed = deps.markLifecycleClosed ?? ((reason) => {
            worldLifecycleStore.setState('closed', reason);
        });
        this.evaluateCompatibility = deps.evaluateCompatibility ?? evaluateFoundryVersionCompatibility;
        this.clearWorldRuntimeState = deps.clearWorldRuntimeState ?? ((reason) => {
            // Runtime teardown deliberately preserves SetupManager's world list,
            // while clearing every value derived from the departed active world.
            primaryDocumentCacheCoordinator.clearAll(reason);
            compendiumStore.clear(reason);
            sharedContentStore.clear(reason);
            userPresence.clear();
            worldStateStore.clearRuntimeState(reason);
        });
        this.now = deps.now ?? Date.now;
    }

    public bootstrap(transport: WorldBootstrapTransport, options: WorldBootstrapOptions = {}): Promise<WorldBootstrapResult> {
        if (this.ready) {
            return Promise.resolve({
                ready: true,
                systemId: this.getSystem()?.id || this.activeSystemId || undefined,
            });
        }

        if (this.bootstrapPromise) {
            if (this.bootstrapEpoch === this.runtimeEpoch) return this.bootstrapPromise;

            // A reconnect may arrive while an invalidated bootstrap is still
            // unwinding. Serialize the replacement so old async Store seeds
            // cannot land after the new world's authoritative seed.
            return this.bootstrapPromise
                .catch(() => undefined)
                .then(() => this.bootstrap(transport, options));
        }

        // Connect, status, and retry paths may all ask for bootstrap. The first
        // caller owns the run; everyone else observes the same in-flight promise.
        const epoch = this.runtimeEpoch;
        const run = this.runBootstrap(transport, options, epoch);
        const tracked = run.finally(() => {
            if (this.bootstrapPromise === tracked) {
                this.bootstrapPromise = null;
                this.bootstrapEpoch = null;
            }
        });
        this.bootstrapPromise = tracked;
        this.bootstrapEpoch = epoch;

        return this.bootstrapPromise;
    }

    public isReady(): boolean {
        return this.ready;
    }

    public getFoundryCompatibility(): FoundryVersionCompatibilityDiagnostic | null {
        return this.lastCompatibility ? { ...this.lastCompatibility } : null;
    }

    public reset(reason = 'world-bootstrap-reset'): void {
        // Increment first so any in-flight bootstrap or repair response becomes
        // stale before active-world Stores are emptied.
        logger.debug('WorldBootstrapper | Tearing down active world runtime', {
            reason,
            previousEpoch: this.runtimeEpoch,
            nextEpoch: this.runtimeEpoch + 1,
        });
        this.runtimeEpoch += 1;
        this.ready = false;
        this.clearActiveAdapter(reason);
        this.clearWorldRuntimeState(reason);
    }

    public getRuntimeEpoch(): number {
        return this.runtimeEpoch;
    }

    private async runBootstrap(
        transport: WorldBootstrapTransport,
        options: WorldBootstrapOptions,
        epoch: number,
    ): Promise<WorldBootstrapResult> {
        logger.info('WorldBootstrapper | Beginning world bootstrap...');

        try {
            const snapshot = await this.getBootstrapSnapshot(transport);
            this.assertCurrentEpoch(epoch);
            if (snapshot) {
                // Compatibility is evaluated while the snapshot is still raw.
                // Older known-bad shapes must fail before Stores become current;
                // newer/unknown shapes proceed with a warning for operators.
                this.handleCompatibilityResult(this.evaluateCompatibility(snapshot.gameData.release));

                // CoreSocket may fetch the raw bytes, but this is the Store
                // acceptance boundary for the connected-world snapshot.
                this.seedWorldSnapshot(snapshot);
                await this.seedUserSnapshot(snapshot);
                this.assertCurrentEpoch(epoch);
            }

            // Per ADR-0021, bootstrap seeds pack metadata passively from
            // game.data.packs — no transport calls. Hydration of index rows
            // or documents is driven later by the active module's info.json
            // through CompendiumService.hydratePacks(...).
            if (snapshot?.gameData) {
                this.seedPackMetadata(snapshot.gameData);
                const packCount = (snapshot.gameData.packs?.length ?? 0)
                    + (snapshot.gameData.system?.packs?.length ?? 0)
                    + (snapshot.gameData.world?.packs?.length ?? 0)
                    + (snapshot.gameData.modules?.reduce((n, m) => n + (m.packs?.length ?? 0), 0) ?? 0);
                logger.info(`WorldBootstrapper | Seeded compendium pack metadata from game data (${packCount} entries across sources).`);
            }
            const compendiumService = this.createCompendiumService(transport);

            const sysInfo = this.getSystem();
            if (sysInfo?.id) {
                const sysId = sysInfo.id.toLowerCase();
                const registered = this.getRegisteredModules();
                const moduleInfo = registered.find(module => module.id.toLowerCase() === sysId);
                const adapter = await this.loadActiveAdapterForEpoch(sysId, epoch);

                let compendiumPackConfig = moduleInfo?.compendiumPacks;
                if (!compendiumPackConfig && hasCompendiumPackConfig(adapter)) {
                    compendiumPackConfig = adapter.getCompendiumPackConfig();
                }

                if (compendiumPackConfig) {
                    await this.hydrateCompendiumPacks(sysId, compendiumPackConfig, compendiumService);
                    this.assertCurrentEpoch(epoch);
                }

                // Routes are not ready until every registered primary-document
                // Store has completed its bootstrap seed.
                await this.seedDocuments(transport);
                this.assertCurrentEpoch(epoch);

                if (hasInitialize(adapter)) {
                    logger.info(`WorldBootstrapper | Initializing adapter for ${sysInfo.id}...`);
                    const runtime = await this.createModuleRuntime(sysId);
                    this.assertCurrentEpoch(epoch);
                    this.activeRuntime = runtime;
                    await adapter.initialize(runtime);
                    this.assertCurrentEpoch(epoch);
                }

                this.assertCurrentEpoch(epoch);
                this.ready = true;
                this.markLifecycleActive(sysInfo.id);
                await options.onReady?.({ systemId: sysInfo.id });
                this.assertCurrentEpoch(epoch);
                logger.info('WorldBootstrapper | World bootstrap complete.');
                return { ready: true, systemId: sysInfo.id };
            }

            this.assertCurrentEpoch(epoch);
            this.ready = true;
            this.markLifecycleActive();
            logger.info('WorldBootstrapper | World bootstrap complete.');
            return { ready: true };
        } catch (error) {
            if (error instanceof StaleWorldBootstrapError) {
                logger.debug('WorldBootstrapper | Discarded stale bootstrap after runtime teardown.');
            } else {
                logger.error(`WorldBootstrapper | Bootstrap encountered error: ${getErrorMessage(error)}`);
                // Partial snapshot, pack, and primary-document seeds are never
                // allowed to remain readable after a failed bootstrap.
                if (this.runtimeEpoch === epoch) this.reset('world-bootstrap-failed');
            }
            throw error;
        }
    }

    public async loadActiveAdapter(systemId: string): Promise<SystemAdapter | null> {
        return this.loadActiveAdapterForEpoch(systemId, this.runtimeEpoch);
    }

    private async loadActiveAdapterForEpoch(
        systemId: string,
        epoch: number,
    ): Promise<SystemAdapter | null> {
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
            this.assertCurrentEpoch(epoch);
            this.activeSystemId = normalizedSystemId;
            this.activeAdapter = adapter;

            if (adapter) {
                logger.info(`WorldBootstrapper | Loaded active adapter: ${normalizedSystemId}`);
            } else {
                logger.warn(`WorldBootstrapper | No active adapter available for ${normalizedSystemId}`);
            }

            return adapter;
        } catch (error) {
            if (error instanceof StaleWorldBootstrapError) throw error;
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

        // Courtesy teardown (decision 22): fire-and-forget so a slow or throwing dispose
        // never blocks or breaks the world transition.
        const adapter = this.activeAdapter;
        const runtime = this.activeRuntime;
        if (adapter?.dispose && runtime) {
            try {
                void Promise.resolve(adapter.dispose(runtime)).catch((error) => {
                    logger.warn(`WorldBootstrapper | adapter.dispose threw (${reason}): ${getErrorMessage(error)}`);
                });
            } catch (error) {
                logger.warn(`WorldBootstrapper | adapter.dispose threw (${reason}): ${getErrorMessage(error)}`);
            }
        }

        this.activeSystemId = null;
        this.activeAdapter = null;
        this.activeRuntime = null;
    }

    private handleCompatibilityResult(compatibility: FoundryVersionCompatibilityResult): void {
        // Status/admin diagnostics read this last-check surface. Keep it before
        // the throw so unsupported generations remain visible after fail-closed.
        this.lastCompatibility = {
            ...compatibility,
            checkedAt: this.now(),
        };

        if (compatibility.status === 'unsupported') {
            this.markLifecycleClosed(this.getUnsupportedLifecycleReason(compatibility));
        }

        assertFoundryVersionSupported(compatibility);

        if (compatibility.status === 'newer-untested' || compatibility.status === 'unknown') {
            logger.warn(`WorldBootstrapper | ${compatibility.message}`);
        }
    }

    private getUnsupportedLifecycleReason(compatibility: FoundryVersionCompatibilityResult): string {
        const generation = compatibility.generation ?? 'unknown';
        return `unsupported-foundry-generation:${generation}:min-${compatibility.minGeneration}`;
    }

    private assertCurrentEpoch(epoch: number): void {
        if (epoch !== this.runtimeEpoch) throw new StaleWorldBootstrapError();
    }
}

export const worldBootstrapper = new WorldBootstrapper();
