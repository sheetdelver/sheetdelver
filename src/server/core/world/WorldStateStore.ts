import type { CacheData, WorldData } from './SetupManager';
import { cloneDocument } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import type {
    FileStorage,
    FoundryRelease,
    FoundryUpdate,
    GameData,
    ModuleManifest,
    PackageWarnings,
    ProbeWorldData,
    SceneDataCache,
    SchemaModel,
    SchemaModelTypeName,
    ServerAddresses,
    ServerOptions,
    SystemManifest,
    WorldManifest,
} from './types';

// Store values are cloned at the boundary so callers can freely project for
// routes/status without mutating the canonical bootstrap snapshot.
function cloneOrNull<T>(value: T | null | undefined): T | null {
    return value == null ? null : cloneDocument(value);
}

function cloneRecord<T>(value: Record<string, T>): Record<string, T> {
    return cloneDocument(value);
}

/**
 * ADR-0014 home for non-document world state.
 *
 * This Store owns the residual Foundry `game.data` snapshot after primary
 * documents and compendium concerns are handled elsewhere. WorldBootstrapper
 * decides when a connected-world snapshot is accepted; CoreSocket is only the
 * raw transport that can fetch the bytes.
 */
export class WorldStateStore {
    // Active-world snapshot from Foundry's `game.data` wire payload.
    private gameData: GameData | null = null;
    private sceneData: SceneDataCache | null = null;

    // Probe/setup state exists before a full world bootstrap. It lets status
    // routes render a discovered/closed world without pretending Stores are ready.
    private probeWorldData: ProbeWorldData | null = null;
    private probeUserCount = 0;
    private cachedWorldData: WorldData | null = null;
    private cachedWorlds: Record<string, WorldData> = {};
    private ready = false;

    public seed(rawGameData: GameData, options: { sceneData?: SceneDataCache | null } = {}): void {
        // A full active-world seed supersedes probe data, but setup cache stays:
        // cachedWorlds describes the Foundry setup landing page, not this runtime.
        this.gameData = cloneDocument(rawGameData);
        this.sceneData = cloneOrNull(options.sceneData);
        this.probeWorldData = null;
        this.probeUserCount = 0;
        this.ready = true;
    }

    public clear(_reason?: string): void {
        // Full reset for process/world teardown: active snapshot, probe state,
        // and setup-mode cache all become invalid.
        this.gameData = null;
        this.sceneData = null;
        this.probeWorldData = null;
        this.probeUserCount = 0;
        this.cachedWorldData = null;
        this.cachedWorlds = {};
        this.ready = false;
    }

    public clearRuntimeState(_reason?: string): void {
        // Runtime disconnect/setup transition: active-world data is gone, but
        // setup cache can still be useful for the admin/status surface.
        this.gameData = null;
        this.sceneData = null;
        this.probeWorldData = null;
        this.probeUserCount = 0;
        this.ready = false;
    }

    public isReady(): boolean {
        return this.ready;
    }

    public setSceneData(sceneData: SceneDataCache | null | undefined): void {
        this.sceneData = cloneOrNull(sceneData);
    }

    public setProbeData(worldData: ProbeWorldData | null | undefined, userCount: number = 0): void {
        // Probe data is intentionally narrow: it is enough to tell the UI which
        // world was found and how many users exist before service login works.
        this.probeWorldData = cloneOrNull(worldData);
        this.probeUserCount = Number.isFinite(userCount) ? Math.max(0, userCount) : 0;
    }

    public clearProbeData(): void {
        this.probeWorldData = null;
        this.probeUserCount = 0;
    }

    public setCachedWorlds(cache: CacheData): void {
        // SetupManager cache represents the setup-mode world list. It is not
        // authoritative for an active world, but status uses it while disconnected.
        this.cachedWorlds = cloneRecord(cache.worlds || {});
        this.cachedWorldData = cache.currentWorldId ? cloneOrNull(this.cachedWorlds[cache.currentWorldId]) : null;
    }

    public getGameDataSnapshot(): GameData | null {
        // Temporary compatibility escape hatch. Prefer typed accessors below;
        // Phase 5 removes the socket getters that still expose this whole shape.
        return cloneOrNull(this.gameData);
    }

    public getWorld(): WorldManifest | null {
        return cloneOrNull(this.gameData?.world);
    }

    public getSystem(): SystemManifest | null {
        return cloneOrNull(this.gameData?.system);
    }

    public getModules(): ModuleManifest[] {
        return cloneDocument(this.gameData?.modules || []);
    }

    public getRelease(): FoundryRelease | null {
        return cloneOrNull(this.gameData?.release);
    }

    public getCoreUpdate(): FoundryUpdate | null {
        return cloneOrNull(this.gameData?.coreUpdate);
    }

    public getSystemUpdate(): FoundryUpdate | null {
        return cloneOrNull(this.gameData?.systemUpdate);
    }

    public getOptions(): ServerOptions | null {
        return cloneOrNull(this.gameData?.options);
    }

    public getAddresses(): ServerAddresses | null {
        return cloneOrNull(this.gameData?.addresses);
    }

    public getFiles(): FileStorage | null {
        return cloneOrNull(this.gameData?.files);
    }

    public isPaused(): boolean {
        return this.gameData?.paused === true;
    }

    public isDemoMode(): boolean {
        return this.gameData?.demoMode === true;
    }

    public isIdleLogout(): boolean {
        return this.gameData?.idleLogout === true;
    }

    public getModel(): SchemaModel | null {
        return cloneOrNull(this.gameData?.model);
    }

    public getModelForType(typeName: SchemaModelTypeName | string): Record<string, unknown> | null {
        const model = this.gameData?.model?.[typeName];
        return cloneOrNull(model);
    }

    public getPackageWarnings(): PackageWarnings | null {
        return cloneOrNull(this.gameData?.packageWarnings);
    }

    public getSceneData(): SceneDataCache | null {
        return cloneOrNull(this.sceneData);
    }

    public getProbeData(): ProbeWorldData | null {
        return cloneOrNull(this.probeWorldData);
    }

    public getProbeUserCount(): number {
        return this.probeUserCount;
    }

    public getCachedWorld(worldId: string): WorldData | null {
        return cloneOrNull(this.cachedWorlds[worldId]);
    }

    public getCachedWorldData(): WorldData | null {
        return cloneOrNull(this.cachedWorldData);
    }

    public listCachedWorlds(): Record<string, WorldData> {
        return cloneRecord(this.cachedWorlds);
    }

    public getCurrentWorldId(): string | null {
        return this.gameData?.world?.id || null;
    }

    public getUserId(): string | null {
        return this.gameData?.userId || null;
    }
}

export const worldStateStore = new WorldStateStore();
