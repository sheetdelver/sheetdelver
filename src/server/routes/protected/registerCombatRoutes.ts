import express from 'express';
import { createCombatService } from '@server/services/combats/CombatService';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { isErrorPayload } from '@server/shared/utils/isErrorPayload';
import type { CombatTurnObservation } from '@shared/contracts/combats';
import { EncounterBusyError } from '@server/services/combats/EncounterCommandGuard';

function turnObservation(value: unknown): CombatTurnObservation | null {
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    if (typeof row.active !== 'boolean' || typeof row.started !== 'boolean'
        || !Number.isInteger(row.round) || (row.currentCombatantId !== null
        && typeof row.currentCombatantId !== 'string')) return null;
    return row as unknown as CombatTurnObservation;
}

function getErrorStatus(error: unknown, fallback = 500): number {
    if (typeof error !== 'object' || error === null) return fallback;
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : fallback;
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
export function registerCombatRoutes(appRouter: express.Router) {
    // Combat domain service: displaced logic for listing, turn control, and initiative rolls.
    const combatService = createCombatService({});

    appRouter.get('/combats', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await combatService.listCombats(client);
            res.json(payload);
        } catch (error: unknown) {
            res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
        }
    });

    appRouter.post('/combats/:id/next-turn', async (req, res) => {
        try {
            const client = req.foundryClient;
            const observed = turnObservation(req.body?.observed);
            if (!observed) return res.status(400).json({ error: 'Observed encounter state required' });
            const payload = await combatService.advanceTurn(client, req.params.id, false, observed);
            if (isErrorPayload(payload)) {
                return res.status(payload.status).json({ error: payload.error, ...(payload.code ? { code: payload.code } : {}) });
            }
            res.json({ success: true });
        } catch (error: unknown) {
            res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
        }
    });

    appRouter.post('/combats/:id/previous-turn', async (req, res) => {
        try {
            const client = req.foundryClient;
            const observed = turnObservation(req.body?.observed);
            if (!observed) return res.status(400).json({ error: 'Observed encounter state required' });
            const payload = await combatService.previousTurn(client, req.params.id, false, observed);
            if (isErrorPayload(payload)) {
                return res.status(payload.status).json({ error: payload.error });
            }
            res.json({ success: true });
        } catch (error: unknown) {
            res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
        }
    });

    appRouter.post('/combats/:id/combatants/:combatantId/roll-initiative', async (req, res) => {
        try {
            const client = req.foundryClient;
            const body = req.body;
            if (!body || typeof body !== 'object' || 'formula' in body
                || !body.observed || typeof body.observed !== 'object'
                || !(body.observed.initiative === null || Number.isFinite(body.observed.initiative))
                || typeof body.observed.formula !== 'string'
                || (body.observed.phaseGeneration !== undefined && (typeof body.observed.phaseGeneration !== 'string'
                    || body.observed.phaseGeneration.length > 135))
                || (body.manualTotal !== undefined && !Number.isFinite(body.manualTotal))
                || (body.advantageMode !== undefined && !['normal', 'advantage', 'disadvantage'].includes(body.advantageMode))) {
                return res.status(400).json({ error: 'Invalid initiative request' });
            }
            const payload = await combatService.rollInitiative(client, req.params.id, req.params.combatantId, body);
            if (isErrorPayload(payload)) {
                return res.status(payload.status).json({ error: payload.error, ...(payload.code ? { code: payload.code } : {}) });
            }
            res.json(payload);
        } catch (error: unknown) {
            res.status(error instanceof EncounterBusyError ? 409 : getErrorStatus(error)).json({ error: getErrorMessage(error) });
        }
    });
}
