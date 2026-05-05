import express from 'express';
import type { SystemAdapter } from '@modules/registry/types';
import { logger } from '@shared/utils/logger';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';

interface SystemRoutesDeps {
    getSystemClient: () => {
        getGameData: () => any;
        getSceneData: () => any;
    };
    getAdapter: (systemId: string) => Promise<SystemAdapter | null>;
}

export function registerSystemRoutes(appRouter: express.Router, deps: SystemRoutesDeps) {
    // --- System API (now protected by middleware) ---
    appRouter.get('/system', async (req, res) => {
        try {
            // Auth handled by middleware
            const gameData = deps.getSystemClient().getGameData();
            res.json(gameData?.system || {});
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    // System Data (Already has ensureInitialized via router.use)
    appRouter.get('/system/data', async (req: any, res: any) => {
        try {
            // Auth handled by middleware
            const systemClient = deps.getSystemClient();
            const gameData = systemClient.getGameData();
            const adapter = await deps.getAdapter(gameData.system.id);
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
            // Auth handled by middleware
            const systemClient = deps.getSystemClient();
            const sceneData = systemClient.getSceneData();

            if (!sceneData) {
                return res.status(404).json({ error: 'Scene data not available' });
            }

            res.json(sceneData);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });
}
