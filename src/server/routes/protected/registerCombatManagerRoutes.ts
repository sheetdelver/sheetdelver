import express from 'express';
import { combatManagerService, CombatManagerError } from '@server/services/combats/CombatManagerService';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { createCombatService } from '@server/services/combats/CombatService';

function handleError(error: unknown, res: express.Response): void {
    res.status(error instanceof CombatManagerError ? error.status : 500).json({ error: getErrorMessage(error) });
}

export function registerCombatManagerRoutes(router: express.Router, deps: {
    normalizeActors: (actorList: any[], client: any) => Promise<any[]>;
}): void {
    const combatService = createCombatService(deps);
    router.get('/combat-manager', (req, res) => {
        try { res.json({ encounters: combatManagerService.list(req.foundryClient) }); }
        catch (error) { handleError(error, res); }
    });
    router.get('/combat-manager/world-actors', (req, res) => {
        try { res.json({ actors: combatManagerService.worldActors(req.foundryClient, String(req.query.q || '')) }); }
        catch (error) { handleError(error, res); }
    });
    router.get('/combat-manager/packs', (req, res) => {
        try { res.json({ packs: combatManagerService.packs(req.foundryClient) }); }
        catch (error) { handleError(error, res); }
    });
    router.get('/combat-manager/packs/:packId/actors', async (req, res) => {
        try { res.json({ actors: await combatManagerService.packActors(req.foundryClient, req.params.packId, String(req.query.q || '')) }); }
        catch (error) { handleError(error, res); }
    });
    router.post('/combat-manager', async (req, res) => {
        try { res.status(201).json({ encounter: await combatManagerService.create(req.foundryClient, req.body?.label, req.body?.keepHistory) }); }
        catch (error) { handleError(error, res); }
    });
    router.get('/combat-manager/:id', (req, res) => {
        try { res.json({ encounter: combatManagerService.detail(req.foundryClient, req.params.id) }); }
        catch (error) { handleError(error, res); }
    });
    router.post('/combat-manager/:id/world-actors', async (req, res) => {
        try { res.json({ encounter: await combatManagerService.addWorldActor(req.foundryClient, req.params.id, req.body?.actorId) }); }
        catch (error) { handleError(error, res); }
    });
    router.post('/combat-manager/:id/pack-actors', async (req, res) => {
        try { res.json({ encounter: await combatManagerService.addPackActor(req.foundryClient, req.params.id, req.body?.packId, req.body?.actorId) }); }
        catch (error) { handleError(error, res); }
    });
    router.post('/combat-manager/:id/next-turn', async (req, res) => {
        try {
            const payload = await combatManagerService.turn(req.foundryClient, req.params.id,
                () => combatService.advanceTurn(req.foundryClient, req.params.id, true));
            if ('error' in payload) return res.status(payload.status).json({ error: payload.error });
            res.json(payload);
        } catch (error) { handleError(error, res); }
    });
    router.post('/combat-manager/:id/previous-turn', async (req, res) => {
        try {
            const payload = await combatManagerService.turn(req.foundryClient, req.params.id,
                () => combatService.previousTurn(req.foundryClient, req.params.id, true));
            if ('error' in payload) return res.status(payload.status).json({ error: payload.error });
            res.json(payload);
        } catch (error) { handleError(error, res); }
    });
    router.post('/combat-manager/:id/roll-initiative', async (req, res) => {
        try {
            const payload = await combatManagerService.rollInitiativeBatch(req.foundryClient, req.params.id,
                req.body?.scope, combatantId => combatService.rollInitiative(req.foundryClient,
                    req.params.id, combatantId, {}, true));
            res.json(payload);
        } catch (error) { handleError(error, res); }
    });
    router.patch('/combat-manager/:id/combatants/:combatantId', async (req, res) => {
        try { res.json({ encounter: await combatManagerService.updateParticipant(req.foundryClient, req.params.id, req.params.combatantId, req.body || {}) }); }
        catch (error) { handleError(error, res); }
    });
    router.patch('/combat-manager/:id/combatants/:combatantId/resource', async (req, res) => {
        try { res.json({ encounter: await combatManagerService.updateResource(req.foundryClient, req.params.id, req.params.combatantId, req.body?.value) }); }
        catch (error) { handleError(error, res); }
    });
    router.delete('/combat-manager/:id/combatants/:combatantId', async (req, res) => {
        try { res.json({ encounter: await combatManagerService.removeParticipant(req.foundryClient, req.params.id, req.params.combatantId) }); }
        catch (error) { handleError(error, res); }
    });
    router.post('/combat-manager/:id/complete', async (req, res) => {
        try { res.json(await combatManagerService.complete(req.foundryClient, req.params.id)); }
        catch (error) { handleError(error, res); }
    });
}
