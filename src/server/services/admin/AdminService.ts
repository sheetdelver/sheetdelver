import { logger } from '@shared/utils/logger';
import { systemService } from '@core/system/SystemService';
import { SetupManager } from '@core/foundry/SetupManager';
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
            worldState: client.worldState,
            userId: client.userId,
            isExplicit: client.isExplicitSession,
            discoveredUserId: client.discoveredUserId
        };
    };

    // World listing flow with scrape-first and cache fallback behavior.
    const listWorlds = async () => {
        const client = systemService.getSystemClient() as unknown as AdminStatusClientLike;
        let worlds: WorldEntry[] = [];

        worlds = await SetupManager.scrapeAvailableWorlds(client.url || '');

        if (worlds.length === 0) {
            const cache = await SetupManager.loadCache();
            if (cache.currentWorldId && cache.worlds[cache.currentWorldId]) {
                worlds = [cache.worlds[cache.currentWorldId]];
            }
        }

        return worlds;
    };

    const getCache = async () => {
        return SetupManager.loadCache();
    };

    // Manual setup scrape used by local admin workflows.
    // TODO Fix: The scraper should be done on the backend, however we will leave the single world scrape to be fixed later.
    const scrapeSetup = async (sessionCookie: string) => {
        if (!sessionCookie) return { error: 'Session cookie required', status: 400 };

        const client = systemService.getSystemClient() as unknown as AdminStatusClientLike;
        logger.info('Core Service | Triggering manual deep-scrape via CLI...');

        const result = await SetupManager.scrapeWorldData(client.url || '', sessionCookie);
        await SetupManager.saveCache(result);

        return { success: true, data: result };
    };

    const launchWorld = async (worldId: string) => {
        const client = systemService.getSystemClient() as unknown as AdminStatusClientLike;
        await client.launchWorld(worldId);
        return { success: true as const, message: `Request to launch world ${worldId} sent.` };
    };

    const shutdownWorld = async () => {
        const client = systemService.getSystemClient() as unknown as AdminStatusClientLike;
        await client.shutdownWorld();
        return { success: true as const, message: 'Request to shut down current world sent.' };
    };

    return {
        getStatus,
        listWorlds,
        getCache,
        scrapeSetup,
        launchWorld,
        shutdownWorld
    };
}
