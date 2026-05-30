import { systemService } from '@server/services/world';
import { SetupManager } from '@core/world/SetupManager';
import { worldLifecycleStore } from '@server/core/world/WorldLifecycleStore';
import type {
    AdminServiceDeps,
    AdminServiceResult,
    AdminStatusClientLike,
    WorldEntry,
} from '@server/shared/types/admin';

export function createAdminService(deps: AdminServiceDeps): AdminServiceResult {
    // Admin status projection used by the Admin UI and local maintenance surfaces.
    const getStatus = async () => {
        const systemStatus = await deps.getSystemStatusPayload();
        const client = systemService.getSystemClient() as unknown as AdminStatusClientLike;
        return {
            ...systemStatus,
            socket: client.isConnected,
            worldState: worldLifecycleStore.getState(),
            userId: client.userId,
            isExplicit: client.isExplicitSession,
            discoveredUserId: client.discoveredUserId
        };
    };

    // World listing reads from the imported-worlds cache only. Per ADR-0022
    // Phase 1, in-app world scraping was removed; operators can re-import
    // worlds via `npm run admin:import` (or use `npm run admin:scrape` for
    // a one-shot authenticated probe) and re-warm the cache that way.
    const listWorlds = async () => {
        const worlds: WorldEntry[] = [];
        const cache = await SetupManager.loadCache();
        if (cache.currentWorldId && cache.worlds[cache.currentWorldId]) {
            worlds.push(cache.worlds[cache.currentWorldId]);
        }
        return worlds;
    };

    const getCache = async () => {
        return SetupManager.loadCache();
    };

    const launchWorld = async (worldId: string) => {
        await systemService.launchWorld(worldId);
        return { success: true as const, message: `Foundry accepted launch request for world ${worldId}.` };
    };

    const shutdownWorld = async () => {
        await systemService.shutdownWorld();
        return { success: true as const, message: 'Foundry accepted shutdown request for the current world.' };
    };

    return {
        getStatus,
        listWorlds,
        getCache,
        launchWorld,
        shutdownWorld
    };
}
