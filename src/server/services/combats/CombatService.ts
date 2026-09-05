import { logger } from '@shared/utils/logger';
import { getAdapter } from '@modules/registry/server';
import type { ActorDocument } from '@server/shared/types/actors';
import type { CombatClientLike } from '@server/shared/types/documents';
import {
    DOCUMENT_VISIBILITY,
    isAssistantGM,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { combatStore } from '@server/core/documents/primary/combats/CombatStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { combatEncounterReadModel, type PreparedEncounter } from '@server/core/documents/encounters/CombatEncounterReadModel';
import { PrimaryDocumentCacheNotReadyError } from '@server/core/documents/primary/errors';
import { CombatRepository } from '@server/core/documents/primary/combats/CombatRepository';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { getDocumentId } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import { buildCombatTrackerDto } from './CombatTrackerProjection';
import type {
    CombatTrackerDto,
    CombatTrackerActorDto,
    CombatListPayload,
    CombatTurnSuccessPayload,
    CombatInitiativeSuccessPayload,
    CombatInitiativeRequestBody,
    CombatErrorPayload,
} from '@shared/contracts/combats';

interface AdapterWithInitiativeFormula {
    getInitiativeFormula?: (actor: ActorDocument) => string;
}

interface CombatServiceDeps {
    normalizeActors: (actorList: ActorDocument[], client: CombatClientLike) => Promise<ActorDocument[]>;
}

function resolveSubject(userId: string | null | undefined): DocumentAccessSubject | null {
    return userStore.createAccessSubject(userId);
}

const projectionDeps = {
    canWriteActor: (actorId: string, subject: DocumentAccessSubject) =>
        actorStore.canReadActor(actorId, subject, DOCUMENT_VISIBILITY.WRITEABLE),
};

export function createCombatService(deps: CombatServiceDeps) {
    const createCombatRepository = (client: CombatClientLike): CombatRepository => new CombatRepository({
        dispatchDocument: (
            type: string,
            action: string,
            operation?: unknown,
            parent?: { type: string; id: string },
        ) => client.dispatchDocument(type, action, operation, parent),
    });

    const ensureReady = (): void => {
        if (!combatStore.isReady()) throw new PrimaryDocumentCacheNotReadyError('Combat');
    };

    /**
     * Attach the minimal actor roll payload to rows the subject may roll for,
     * and resolve display image paths against the Foundry URL prefix. Actor
     * data is fetched through the subject-scoped `client.getActor`, so a row
     * only carries an actor the caller could read in full anyway; it is then
     * whitelisted to id/name/img/system (no ownership, no raw spread).
     */
    const enrichTrackerDto = async (dto: CombatTrackerDto, client: CombatClientLike): Promise<CombatTrackerDto> => {
        const rollableActorIds = [...new Set(
            dto.combatants
                .filter(row => row.canRollInitiative && row.actorId)
                .map(row => row.actorId as string),
        )];

        const actorsById = new Map<string, CombatTrackerActorDto>();
        const fetched: ActorDocument[] = [];
        await Promise.all(rollableActorIds.map(async (actorId) => {
            try {
                const actor = await client.getActor(actorId);
                if (actor) fetched.push(actor);
            } catch {
                logger.error(`Failed to fetch actor ${actorId} for combat ${dto.id}`);
            }
        }));
        const normalized = await deps.normalizeActors(fetched, client);
        for (const actor of normalized) {
            const id = actor._id || actor.id;
            if (!id) continue;
            actorsById.set(id, {
                id,
                name: typeof actor.name === 'string' ? actor.name : null,
                img: typeof actor.img === 'string' ? actor.img : null,
                system: actor.system as Record<string, unknown> | undefined,
            });
        }

        return {
            ...dto,
            combatants: dto.combatants.map(row => ({
                ...row,
                img: typeof row.img === 'string' ? client.resolveUrl(row.img) : row.img,
                actor: row.actorId ? actorsById.get(row.actorId) ?? null : null,
            })),
        };
    };

    // Tracker projection list (ADR-0028 Phases 4): prepared encounters from
    // the read model, redacted + capability-annotated per subject, then
    // enriched with roll actors. No raw documents are spread to the client.
    const listCombats = async (client: CombatClientLike): Promise<CombatListPayload> => {
        ensureReady();
        const subject = resolveSubject(client.userId);
        if (!subject) return { success: true, combats: [] };

        const visible = combatStore.list({ subject });
        const combats = await Promise.all(visible.map(async (combat) => {
            const combatId = getDocumentId(combat);
            if (!combatId) return null;
            const prepared = combatEncounterReadModel.getOrRebuild(combatId);
            if (!prepared) return null;
            const dto = buildCombatTrackerDto(prepared, subject, projectionDeps);
            return enrichTrackerDto(dto, client);
        }));

        return { success: true, combats: combats.filter((c): c is CombatTrackerDto => c !== null) };
    };

    /**
     * Load the prepared encounter for a combat action. Falls back to a silent
     * rebuild for cold read models; null means the combat doesn't exist.
     */
    const getPreparedEncounter = (combatId: string): PreparedEncounter | null => {
        if (!combatStore.get(combatId)) return null;
        return combatEncounterReadModel.getOrRebuild(combatId);
    };

    // Authorization for turn advancement: ASSISTANT-GM and above always; a
    // player only when the current combatant resolves (started, in range,
    // visible to them) and they OWN its actor via
    // `actorStore.canReadActor(..., WRITEABLE)` (ADR-0013 Phase 1). Starting
    // an unstarted encounter therefore requires a GM.
    const isAuthorizedForCombatTurn = (
        prepared: PreparedEncounter,
        subject: DocumentAccessSubject,
    ): boolean => {
        if (isAssistantGM(subject)) return true;
        if (!prepared.currentCombatantId) return false;
        const current = prepared.rows.find(row => row.id === prepared.currentCombatantId);
        if (!current || current.hidden || !current.actorId) return false;
        return projectionDeps.canWriteActor(current.actorId, subject);
    };

    // Turn progression over the prepared encounter order.
    //
    // Sheet Delver command contract (ADR-0028 §6 fallback, explicit until/
    // unless a Foundry command bridge lands): round 0 starts at round 1 on
    // the first eligible combatant; the last eligible turn wraps to the next
    // round. When the world's skip-defeated tracker toggle
    // (`core.combatTrackerConfig.skipDefeated`, default off — Foundry
    // parity) is enabled, defeated rows are skipped in both directions.
    // Defeated means the combatant flag or the actor's `dead` status — never
    // unconscious/dying, so death-save turns are preserved. If every row is
    // ineligible, progression falls back to index 0 rather than looping.
    const isSkipDefeatedEnabled = (): boolean => {
        const config = settingStore.getValueByKey('core.combatTrackerConfig');
        return typeof config === 'object' && config !== null
            && (config as Record<string, unknown>).skipDefeated === true;
    };

    const advanceTurn = async (
        client: CombatClientLike,
        combatId: string
    ): Promise<CombatTurnSuccessPayload | CombatErrorPayload> => {
        ensureReady();
        const prepared = getPreparedEncounter(combatId);
        if (!prepared) {
            return { error: 'Combat not found', status: 404 };
        }

        const subject = resolveSubject(client.userId);
        if (!subject || !isAuthorizedForCombatTurn(prepared, subject)) {
            return { error: 'Unauthorized: You do not own the current combatant and are not a GM', status: 403 };
        }

        const skipDefeated = isSkipDefeatedEnabled();
        const eligible = (row: PreparedEncounter['rows'][number]): boolean =>
            !skipDefeated || !row.defeated;
        const firstEligibleIndex = (): number => {
            const index = prepared.rows.findIndex(eligible);
            return index >= 0 ? index : 0;
        };

        let round = prepared.round;
        let turn = prepared.turn ?? -1;

        if (round === 0) {
            round = 1;
            turn = firstEligibleIndex();
        } else {
            const next = prepared.rows.findIndex((row, index) => index > turn && eligible(row));
            if (next >= 0) {
                turn = next;
            } else {
                round += 1;
                turn = firstEligibleIndex();
            }
        }

        await createCombatRepository(client).update(combatId, { round, turn });

        return { success: true, round, turn };
    };

    // Turn rewind, GM-only. Rewinding past round 1 turn 0 returns the
    // encounter to its unstarted round-zero state.
    const previousTurn = async (
        client: CombatClientLike,
        combatId: string
    ): Promise<CombatTurnSuccessPayload | CombatErrorPayload> => {
        ensureReady();
        const prepared = getPreparedEncounter(combatId);
        if (!prepared) {
            return { error: 'Combat not found', status: 404 };
        }

        const subject = resolveSubject(client.userId);
        if (!subject || !isAssistantGM(subject)) {
            return { error: 'Unauthorized: Only GMs can move to previous turns', status: 403 };
        }

        let round = prepared.round;
        let turn = prepared.turn ?? 0;

        // Rewind mirrors the advance contract: with the world skip-defeated
        // toggle enabled, defeated rows are skipped in reverse; crossing the
        // round boundary lands on the previous round's last eligible row, and
        // rewinding past round 1 turn 0 returns the encounter to its
        // unstarted round-zero state.
        const skipDefeated = isSkipDefeatedEnabled();
        const eligible = (row: PreparedEncounter['rows'][number]): boolean =>
            !skipDefeated || !row.defeated;
        const previousEligible = (before: number): number => {
            for (let i = Math.min(before, prepared.rows.length) - 1; i >= 0; i -= 1) {
                if (eligible(prepared.rows[i])) return i;
            }
            return -1;
        };
        const lastEligible = (): number => {
            for (let i = prepared.rows.length - 1; i >= 0; i -= 1) {
                if (eligible(prepared.rows[i])) return i;
            }
            return Math.max(0, prepared.rows.length - 1);
        };

        if (round === 0) {
            // Not started — nothing to rewind.
        } else {
            const previous = previousEligible(turn);
            if (previous >= 0) {
                turn = previous;
            } else if (round > 1) {
                round -= 1;
                turn = lastEligible();
            } else {
                round = 0;
                turn = 0;
            }
        }

        await createCombatRepository(client).update(combatId, { round, turn });

        return { success: true, round, turn };
    };

    // Initiative roll orchestration with adapter initiative formula fallback.
    // Authorization runs BEFORE any side effect (ADR-0028 Phase 5 preflight /
    // audit CMB-04): an unauthorized caller triggers no roll, no chat
    // message, and no document dispatch. Hidden combatants return the same
    // 404 as missing ones for non-GMs so their existence doesn't leak.
    const rollInitiative = async (
        client: CombatClientLike,
        combatId: string,
        combatantId: string,
        body: CombatInitiativeRequestBody
    ): Promise<CombatInitiativeSuccessPayload | CombatErrorPayload> => {
        ensureReady();
        const { formula, advantageMode } = body;

        const combat = combatStore.get(combatId);
        if (!combat) return { error: 'Combat not found', status: 404 };

        const subject = resolveSubject(client.userId);
        if (!subject) return { error: 'Unauthorized', status: 403 };
        const gm = isAssistantGM(subject);

        const combatant = combat.combatants?.find((c) => (c._id || c.id) === combatantId);
        if (!combatant || (combatant.hidden && !gm)) {
            return { error: 'Combatant not found', status: 404 };
        }
        if (!combatant.actorId) return { error: 'Actor not found', status: 404 };
        if (!gm && !projectionDeps.canWriteActor(combatant.actorId, subject)) {
            return { error: 'Unauthorized: You do not own this combatant', status: 403 };
        }

        const systemInfo = await client.getSystem();
        const adapter = await getAdapter(systemInfo.id.toLowerCase());
        if (!adapter) throw new Error(`Adapter ${systemInfo.id} not found`);

        const actor = await client.getActor(combatant.actorId);
        if (!actor) return { error: 'Actor not found', status: 404 };

        let finalFormula = formula;
        if (!finalFormula) {
            const initiativeAdapter = adapter as AdapterWithInitiativeFormula;
            if (typeof initiativeAdapter.getInitiativeFormula === 'function') {
                finalFormula = initiativeAdapter.getInitiativeFormula(actor);
            } else {
                finalFormula = '1d20';
            }
        }

        if (advantageMode === 'advantage') {
            finalFormula = finalFormula.replace(/^(?:1d20|2d20k[hl]1)/i, '2d20kh1');
        } else if (advantageMode === 'disadvantage') {
            finalFormula = finalFormula.replace(/^(?:1d20|2d20k[hl]1)/i, '2d20kl1');
        } else if (advantageMode === 'normal') {
            finalFormula = finalFormula.replace(/^(?:2d20k[hl]1)/i, '1d20');
        }

        const speaker = {
            actor: actor._id || actor.id,
            alias: actor.name
        };

        const chatMessage = await client.roll(finalFormula, 'Initiative', { speaker });
        const total = parseInt(String(chatMessage.content));

        if (isNaN(total)) {
            throw new Error('Failed to parse roll total from chat message');
        }

        await createCombatRepository(client).updateCombatant(combatId, combatantId, { initiative: total });

        return { success: true, initiative: total };
    };

    return {
        listCombats,
        advanceTurn,
        previousTurn,
        rollInitiative
    };
}
