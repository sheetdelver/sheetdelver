import express from 'express';
import type { SystemAdapter } from '@modules/registry/types';
import { logger } from '@shared/utils/logger';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { sceneStore } from '@server/core/documents/primary/scenes/SceneStore';
import { DocumentOwnershipLevel } from '@server/core/documents/primary/base/ownership';
import { createModuleRuntime } from '@server/shared/utils/createModuleRuntime';
import { createModuleRequestRuntime } from '@server/shared/utils/moduleDocumentServices';

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
            const system = worldStateStore.getSystem();
            const adapter = system?.id ? await deps.getAdapter(system.id) : null;
            const adapterName = adapter?.constructor?.name || 'Unknown';
            const userId = req.userSession?.userId;
            const user = typeof userId === 'string' ? userStore.get(userId) : null;
            if (!user) return res.status(403).json({ error: 'Current Foundry user required' });
            if (adapter?.getSystemDataForUser && req.foundryClient && system?.id) {
                const runtime = createModuleRequestRuntime(await createModuleRuntime(system.id), req.foundryClient);
                const documents = Object.freeze({ get: runtime.documents.get, list: runtime.documents.list, fetchByUuid: runtime.documents.fetchByUuid });
                const data = await adapter.getSystemDataForUser({ documents, compendium: runtime.compendium, access: runtime.access, world: runtime.world });
                if (userStore.get(userId)?.role !== user.role) return res.status(403).json({ error: 'Foundry access changed' });
                return res.json(data);
            }
            // An opaque bootstrap cache cannot be safely filtered by Core.
            // Legacy adapters remain available to full GMs; ordinary callers
            // require the explicit caller-safe projection above (G8 adoption).
            if (user.role !== 4) return res.status(403).json({ error: 'Module has not provided a caller-safe system data projection', code: 'caller-projection-required' });

            if (adapter && adapter.getSystemData) {
                const data = await adapter.getSystemData();
                if (userStore.get(userId)?.role !== 4) return res.status(403).json({ error: 'Foundry role changed' });
                logger.debug(`[CoreService] [PID:${process.pid}] System data fetched (${adapterName}). Keys: ${Object.keys(data || {}).length}`);
                res.json(data);
            } else {
                res.json({});
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
            const userId = req.userSession?.userId;
            if (!userId || !userStore.get(userId)) return res.status(403).json({ error: 'Current Foundry user required' });
            const subject = userStore.createAccessSubject(userId);
            // This legacy inspection route is not a player Scene/canvas SDK.
            if (!subject || subject.role !== 4) return res.status(403).json({ error: 'Full Gamemaster required for scene inspection' });
            const sceneData = sceneStore.isReady() ? Object.fromEntries(sceneStore.list({ subject, minOwnership: DocumentOwnershipLevel.OBSERVER }).map(scene => [String(scene._id ?? scene.id), scene])) : null;

            if (!sceneData) {
                return res.status(404).json({ error: 'Scene data not available' });
            }

            res.json(sceneData);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });
}
