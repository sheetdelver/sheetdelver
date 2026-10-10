import express from 'express';
import { combatManagerService, CombatManagerError } from '@server/services/combats/CombatManagerService';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { createCombatService } from '@server/services/combats/CombatService';
import { logger } from '@shared/utils/logger';

function handleError(error: unknown, res: express.Response): void {
    res.status(error instanceof CombatManagerError ? error.status : 500).json({ error: getErrorMessage(error),
        ...(error instanceof CombatManagerError && error.code ? { code: error.code } : {}) });
}

export function registerCombatManagerRoutes(router: express.Router, deps: {
    normalizeActors: (actorList: any[], client: any) => Promise<any[]>;
}): void {
    const combatService = createCombatService(deps);
    router.get('/combat-manager', async (req, res) => {
        try { res.json({ encounters: await combatManagerService.list(req.foundryClient) }); }
        catch (error) { handleError(error, res); }
    });
    router.get('/combat-manager/stat-preferences', async (req, res) => {
        try { res.json({ preferences: await combatManagerService.statPreferences(req.foundryClient, req.query.actorId, req.query.catalog === '1') }); }
        catch (error) { handleError(error, res); }
    });
    router.put('/combat-manager/stat-preferences', async (req, res) => {
        try { res.json({ preferences: await combatManagerService.saveStatPreferences(req.foundryClient, req.body?.attributes) }); }
        catch (error) { handleError(error, res); }
    });
    router.delete('/combat-manager/stat-preferences', async (req, res) => {
        try { res.json({ preferences: await combatManagerService.resetStatPreferences(req.foundryClient) }); }
        catch (error) { handleError(error, res); }
    });
    router.put('/combat-manager/initiative-fallback', async (req, res) => {
        try { res.json({ preferences: await combatManagerService.saveInitiativeFormula(req.foundryClient, req.body?.formula) }); }
        catch (error) { handleError(error, res); }
    });
    router.get('/combat-manager/world-actors', (req, res) => {
        try { res.json(combatManagerService.worldActors(req.foundryClient, String(req.query.q || ''), req.query.sort)); }
        catch (error) { handleError(error, res); }
    });
    router.get('/combat-manager/packs', (req, res) => {
        try { res.json({ packs: combatManagerService.packs(req.foundryClient) }); }
        catch (error) { handleError(error, res); }
    });
    router.get('/combat-manager/packs/:packId/actors', async (req, res) => {
        try { res.json(await combatManagerService.packActors(req.foundryClient, req.params.packId,
            String(req.query.q || ''), req.query.sort)); }
        catch (error) { handleError(error, res); }
    });
    router.post('/combat-manager', async (req, res) => {
        try { res.status(201).json({ encounter: await combatManagerService.create(req.foundryClient, req.body?.label, req.body?.keepHistory) }); }
        catch (error) { handleError(error, res); }
    });
    router.get('/combat-manager/:id', async (req, res) => {
        try { res.json({ encounter: await combatManagerService.detail(req.foundryClient, req.params.id) }); }
        catch (error) { handleError(error, res); }
    });
    router.patch('/combat-manager/:id', async (req, res) => {
        try { res.json({ encounter: await combatManagerService.rename(req.foundryClient, req.params.id, req.body?.label) }); }
        catch (error) { handleError(error, res); }
    });
    router.delete('/combat-manager/:id', async (req, res) => {
        try { res.json(await combatManagerService.destroy(req.foundryClient, req.params.id)); }
        catch (error) { handleError(error, res); }
    });
    router.post('/combat-manager/:id/world-actors', async (req, res) => {
        try { res.json({ encounter: await combatManagerService.addWorldActor(req.foundryClient, req.params.id, req.body?.actorId) }); }
        catch (error) { handleError(error, res); }
    });
    router.post('/combat-manager/:id/pack-actors', async (req, res) => {
        try { res.json({ encounter: await combatManagerService.addPackActor(req.foundryClient, req.params.id,
            req.body?.packId, req.body?.actorId, req.body?.quantity) }); }
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
                req.body?.scope, (combatantId, initiativeFallback) => combatService.rollInitiative(req.foundryClient,
                    req.params.id, combatantId, {}, true, initiativeFallback));
            res.json(payload);
        } catch (error) { handleError(error, res); }
    });
    router.post('/combat-manager/:id/combatants/:combatantId/roll-initiative', async (req, res) => {
        try {
            const mode = req.body?.advantageMode;
            if (mode !== undefined && !['normal', 'advantage', 'disadvantage'].includes(mode)) {
                return res.status(400).json({ error: 'Invalid initiative mode' });
            }
            res.json(await combatManagerService.rollInitiativeOne(req.foundryClient, req.params.id,
                req.params.combatantId, combatantId => combatService.rollInitiative(req.foundryClient,
                    req.params.id, combatantId, { advantageMode: mode }, true)));
        } catch (error) { handleError(error, res); }
    });
    router.post('/combat-manager/:id/reset-initiative', async (req, res) => {
        try { res.json(await combatManagerService.resetInitiative(req.foundryClient, req.params.id)); }
        catch (error) { handleError(error, res); }
    });
    router.patch('/combat-manager/:id/combatants/:combatantId', async (req, res) => {
        try { res.json({ encounter: await combatManagerService.updateParticipant(req.foundryClient, req.params.id, req.params.combatantId, req.body || {}) }); }
        catch (error) { handleError(error, res); }
    });
    router.patch('/combat-manager/:id/combatants/:combatantId/resource', async (req, res) => {
        try { res.json({ encounter: await combatManagerService.updateResource(req.foundryClient, req.params.id, req.params.combatantId, req.body) }); }
        catch (error) { handleError(error, res); }
    });
    router.patch('/combat-manager/:id/combatants/:combatantId/stats/:statKey', async (req, res) => {
        try { res.json({ encounter: await combatManagerService.updateStat(req.foundryClient, req.params.id, req.params.combatantId, req.params.statKey, req.body) }); }
        catch (error) { handleError(error, res); }
    });
    router.post('/combat-manager/:id/health-batch', async (req, res) => {
        try { res.json(await combatManagerService.applyHealthBatch(req.foundryClient, req.params.id, req.body)); }
        catch (error) { handleError(error, res); }
    });
    router.delete('/combat-manager/:id/combatants/:combatantId', async (req, res) => {
        try { res.json({ encounter: await combatManagerService.removeParticipant(req.foundryClient, req.params.id, req.params.combatantId) }); }
        catch (error) { handleError(error, res); }
    });
    router.post('/combat-manager/:id/complete', async (req, res) => {
        try {
            logger.info('CombatManager | Completion requested', {
                combatId: req.params.id,
                userId: req.foundryClient.userId,
            });
            res.json(await combatManagerService.complete(req.foundryClient, req.params.id));
        }
        catch (error) { handleError(error, res); }
    });
}
