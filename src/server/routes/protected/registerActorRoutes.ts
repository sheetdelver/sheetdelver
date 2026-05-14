import express from 'express';
import type { AppConfig } from '@shared/interfaces';
import { logger } from '@shared/utils/logger';
import { createActorService } from '@server/services/actors/ActorService';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { isErrorPayload } from '@server/shared/utils/isErrorPayload';

interface ActorRouteDeps {
    normalizeActors: (actorList: any[], client: any) => Promise<any[]>;
    config: AppConfig;
}

function getErrorStatus(error: unknown, fallback = 500): number {
    if (typeof error !== 'object' || error === null) return fallback;
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : fallback;
}

export function registerActorRoutes(appRouter: express.Router, deps: ActorRouteDeps) {
    // Actor domain service: displaced business logic for actor list/detail/cards/rolls and mutations.
    const actorService = createActorService(deps);

    appRouter.get('/actors', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await actorService.listActors(client);
            res.json(payload);
        } catch (error: unknown) {
            const message = getErrorMessage(error);
            logger.error(`Core Service | Actors fetch failed: ${message}`);
            res.status(getErrorStatus(error)).json({ error: message });
        }
    });

    appRouter.get('/actors/cards', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await actorService.getActorCards(client);
            res.json(payload);
        } catch (error: unknown) {
            const message = getErrorMessage(error);
            logger.error(`Core Service | Actor cards bulk fetch failed: ${message}`);
            res.status(getErrorStatus(error)).json({ error: message });
        }
    });

    appRouter.get('/actors/:id/card', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await actorService.getActorCardById(client, req.params.id);
            if (isErrorPayload(payload)) {
                return res.status(payload.status).json({ error: payload.error });
            }
            res.json(payload);
        } catch (error: unknown) {
            const message = getErrorMessage(error);
            logger.error(`Core Service | Actor card fetch failed: ${message}`);
            res.status(getErrorStatus(error)).json({ error: message });
        }
    });

    appRouter.get('/actors/:id', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await actorService.getActorById(client, req.params.id);
            if (isErrorPayload(payload)) {
                return res.status(payload.status).json({ error: payload.error });
            }
            res.json(payload);
        } catch (error: unknown) {
            const message = getErrorMessage(error);
            logger.error(`Core Service | Actor detail fetch failed: ${message}`);
            res.status(getErrorStatus(error)).json({ error: message });
        }
    });

    // Create new actor
    appRouter.post('/actors', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await actorService.createActor(client, req.body);
            res.json(payload);
        } catch (error: unknown) {
            const message = getErrorMessage(error);
            logger.error(`Core Service | Create Actor failed: ${message}`);
            res.status(500).json({ success: false, error: message });
        }
    });

    appRouter.delete('/actors/:id', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await actorService.deleteActor(client, req.params.id);
            res.json(payload);
        } catch (error: unknown) {
            const msg = getErrorMessage(error);
            if (msg.toLowerCase().includes('permission')) {
                return res.json({ success: true, warning: 'Permission denied, actor may remain' });
            }
            res.status(500).json({ error: msg });
        }
    });

    appRouter.patch('/actors/:id', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await actorService.updateActor(client, req.params.id, req.body);
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    appRouter.post('/actors/:id/roll', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await actorService.rollActor(client, req.params.id, req.body);
            if (isErrorPayload(payload)) {
                return res.status(payload.status).json({ error: payload.error });
            }
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    appRouter.post('/actors/:id/items', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await actorService.createActorItem(client, req.params.id, req.body);
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ success: false, error: getErrorMessage(error) });
        }
    });

    appRouter.put('/actors/:id/items', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await actorService.updateActorItem(client, req.params.id, req.body);
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ success: false, error: getErrorMessage(error) });
        }
    });

    appRouter.delete('/actors/:id/items', async (req, res) => {
        try {
            const client = req.foundryClient;
            const itemId = req.query.itemId as string;
            const payload = await actorService.deleteActorItem(client, req.params.id, itemId);
            if (isErrorPayload(payload)) {
                return res.status(payload.status).json({ success: false, error: payload.error });
            }
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ success: false, error: getErrorMessage(error) });
        }
    });

    appRouter.post('/actors/:id/update', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await actorService.updateActorAndItems(client, req.params.id, req.body);
            res.json(payload);
        } catch (error: unknown) {
            const message = getErrorMessage(error);
            logger.error(`Core Service | Actor/Item update failed: ${message}`);
            res.status(500).json({ success: false, error: message });
        }
    });
}
