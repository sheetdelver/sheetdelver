import express from 'express';
import { createCombatService } from '@server/services/combats/CombatService';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { isErrorPayload } from '@server/shared/utils/isErrorPayload';

interface CombatRouteDeps {
    normalizeActors: (actorList: any[], client: any) => Promise<any[]>;
}

/**
 * Combat route registrar — ownership-threshold contract (ADR-0013):
 *
 *   GET  /combats                                    → LIST_VISIBLE
 *                                                       (via combatStore.list; visibility derives from
 *                                                        actorStore.canReadActor per non-hidden combatant)
 *   POST /combats/:id/next-turn                      → isAssistantGM OR actorStore.canReadActor(active, WRITEABLE)
 *                                                       (CombatService.isAuthorizedForCombatTurn; ADR-0013 Phase 1)
 *   POST /combats/:id/previous-turn                  → isAssistantGM only
 *                                                       (rewind is GM-only)
 *   POST /combats/:id/combatants/:combatantId/roll-initiative
 *                                                    → isAssistantGM OR actorStore.canReadActor(combatant, WRITEABLE),
 *                                                       checked BEFORE any roll/chat side effect (ADR-0028 preflight);
 *                                                       hidden combatants 404 for non-GMs
 *
 * Verified by `runCombatListVisibilityCrossesActorStore` in
 * `src/tests/unit/routing/route-ownership-thresholds.test.ts`, and the existing
 * `runCombatReadActionSmoke` cases in `actor-combat-smoke.test.ts` cover
 * turn-advancement authorization at OWNER / OBSERVER / non-owner bands.
 */
export function registerCombatRoutes(appRouter: express.Router, deps: CombatRouteDeps) {
    // Combat domain service: displaced logic for listing, turn control, and initiative rolls.
    const combatService = createCombatService(deps);

    appRouter.get('/combats', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await combatService.listCombats(client);
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    appRouter.post('/combats/:id/next-turn', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await combatService.advanceTurn(client, req.params.id);
            if (isErrorPayload(payload)) {
                return res.status(payload.status).json({ error: payload.error });
            }
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    appRouter.post('/combats/:id/previous-turn', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await combatService.previousTurn(client, req.params.id);
            if (isErrorPayload(payload)) {
                return res.status(payload.status).json({ error: payload.error });
            }
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    appRouter.post('/combats/:id/combatants/:combatantId/roll-initiative', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await combatService.rollInitiative(client, req.params.id, req.params.combatantId, req.body);
            if (isErrorPayload(payload)) {
                return res.status(payload.status).json({ error: payload.error });
            }
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });
}
