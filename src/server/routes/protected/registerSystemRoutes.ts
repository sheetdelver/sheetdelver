import express from 'express';
import type { SystemAdapter } from '@modules/registry/types';
import { logger } from '@shared/utils/logger';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { worldStateStore } from '@server/core/world/WorldStateStore';

interface SystemRoutesDeps {
    getSystemClient: () => unknown;
    getAdapter: (systemId: string) => Promise<SystemAdapter | null>;
}

export function registerSystemRoutes(appRouter: express.Router, deps: SystemRoutesDeps) {
    // --- System API (now protected by middleware) ---
    appRouter.get('/system', async (req, res) => {
        try {
            // Auth handled by middleware. System metadata is a Store read now;
            // the route should not reach through SystemService into CoreSocket.
            res.json(worldStateStore.getSystem() || {});
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    // System Data (Already has ensureInitialized via router.use)
    appRouter.get('/system/data', async (req: any, res: any) => {
        try {
            // Auth handled by middleware. The adapter may still need a client
            // for live Foundry calls, but the base world/system snapshot comes
            // from WorldStateStore.
            const systemClient = deps.getSystemClient();
            const gameData = worldStateStore.getGameDataSnapshot();
            const system = worldStateStore.getSystem();
            const adapter = system?.id ? await deps.getAdapter(system.id) : null;
            const adapterName = adapter?.constructor?.name || 'Unknown';

            if (adapter && adapter.getSystemData) {
                const data = await adapter.getSystemData(systemClient as any);
                logger.debug(`[CoreService] [PID:${process.pid}] System data fetched (${adapterName}). Keys: ${Object.keys(data || {}).length}`);
                res.json(data);
            } else {
                // Fallback: Return raw scraper data if adapter doesn't provide more
                res.json(gameData?.data || {});
            }
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    appRouter.get('/system/scenes', async (req, res) => {
        try {
            // Auth handled by middleware. Scene data is the extracted
            // gameData.scenes projection until a later phase gives Scenes their
            // own canonical document surface.
            const sceneData = worldStateStore.getSceneData();

            if (!sceneData) {
                return res.status(404).json({ error: 'Scene data not available' });
            }

            res.json(sceneData);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });
}
