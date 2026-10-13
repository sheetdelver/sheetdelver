import { logger } from '@shared/utils/logger';
import { getAdapter } from '@modules/registry/server';
import type { CombatClientLike, RollChatMessageLike } from '@server/shared/types/documents';
import {
    DOCUMENT_VISIBILITY,
    isGM,
    isAssistantGM,
    FoundryUserRole,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { combatStore } from '@server/core/documents/primary/combats/CombatStore';
import { sceneStore } from '@server/core/documents/primary/scenes/SceneStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { combatEncounterReadModel, type PreparedEncounter } from '@server/core/documents/encounters/CombatEncounterReadModel';
import { PrimaryDocumentCacheNotReadyError } from '@server/core/documents/primary/errors';
import { CombatRepository } from '@server/core/documents/primary/combats/CombatRepository';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { getDocumentId } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import {
    preparedActorStore,
    PreparedActorUnavailableError,
} from '@server/core/documents/prepared/actors/PreparedActorStore';
import type { PreparedActorData, SystemAdapter } from '@shared/sdk';
import type { CombatManagerSelectedStatDto } from '@shared/contracts/combatManager';
import { buildCombatTrackerDto } from './CombatTrackerProjection';
import { readCombatManagerFlag } from './combatManagerFlag';
import { combatStatDisplayService, projectCombatStatFields } from './CombatStatDisplayService';
import { effectiveInitiativeFormula } from './CombatInitiativeFormula';
import { withEncounterLock } from './EncounterCommandGuard';
import type {
    CombatTrackerDto,
    CombatListPayload,
    CombatTurnSuccessPayload,
    CombatInitiativeSuccessPayload,
    CombatInitiativeRequestBody,
    CombatTurnObservation,
    CombatErrorPayload,
} from '@shared/contracts/combats';

interface CombatServiceDeps {
    getPreparedActor?: (actorId: string) => PreparedActorData;
}

function resolveSubject(userId: string | null | undefined): DocumentAccessSubject | null {
    return userStore.createAccessSubject(userId);
}

const projectionDeps = {
    canWriteActor: (actorId: string, subject: DocumentAccessSubject) =>
        actorStore.canReadActor(actorId, subject, DOCUMENT_VISIBILITY.WRITEABLE),
};

export function getCombatInitiativeRollTotal(message: RollChatMessageLike): number {
    // Core chat content is presentation HTML. Read the evaluated Foundry Roll
    // first, retaining numeric content only for older client implementations.
    const serializedRoll = message.rolls?.[0];
    let rollTotal: unknown;
    try {
        rollTotal = typeof serializedRoll === 'string'
            ? (JSON.parse(serializedRoll) as { total?: unknown }).total
            : serializedRoll?.total;
    } catch {
        // Fall back to legacy plain numeric content below.
    }
    const total = typeof rollTotal === 'number'
        ? rollTotal
        : typeof message.content === 'string' && message.content.trim() !== ''
            ? Number(message.content)
            : Number.NaN;
    if (!Number.isFinite(total)) throw new Error('Failed to parse roll total from chat message');
    return total;
}

export function createCombatService(deps: CombatServiceDeps) {
    const getPreparedActor = deps.getPreparedActor
        ?? ((actorId: string) => preparedActorStore.getRequired(actorId));

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

    /** Add bounded owned-stat/roll metadata and resolve display image paths. */
    const enrichTrackerDto = async (dto: CombatTrackerDto, client: CombatClientLike,
        subject: DocumentAccessSubject, attributes: CombatManagerSelectedStatDto[],
        adapter: SystemAdapter | null, initiativeFallback: string | null): Promise<CombatTrackerDto> => {
        const combat = combatStore.get(dto.id);
        return {
            ...dto,
            combatants: dto.combatants.map(row => {
                const source = row.actorId ? actorStore.get(row.actorId, { subject }) : null;
                const owned = !!row.actorId && subject.role < FoundryUserRole.ASSISTANT
                    && projectionDeps.canWriteActor(row.actorId, subject);
                const rawRow = combat?.combatants?.find(entry => (entry._id || entry.id) === row.id);
                const token = rawRow?.sceneId && rawRow.tokenId
                    ? sceneStore.getToken(rawRow.sceneId, rawRow.tokenId) : null;
                const unlinked = !!token && token.actorLink === false;
                let prepared: PreparedActorData | null = null;
                if (row.actorId && (owned || row.canRollInitiative)) {
                    try { prepared = getPreparedActor(row.actorId); }
                    catch (error) {
                        if (!(error instanceof PreparedActorUnavailableError)) throw error;
                    }
                }
                const projectedStats = owned && !unlinked && prepared
                    ? projectCombatStatFields(prepared, attributes).map(stat => ({
                        title: stat.title, value: stat.value,
                        ...(stat.subValue !== undefined ? { subValue: stat.subValue } : {}),
                    })) : [];
                const initiative = row.canRollInitiative && prepared
                    ? effectiveInitiativeFormula(adapter, prepared, initiativeFallback) : null;
                return {
                    ...row,
                    canRollInitiative: row.canRollInitiative && prepared !== null,
                    img: typeof row.img === 'string' ? client.resolveUrl(row.img) : row.img,
                    isOwned: owned,
                    canOpenActor: owned && source !== null,
                    statSource: owned ? unlinked ? 'unlinked-token' as const : 'world-actor' as const : null,
                    stats: projectedStats,
                    initiativeRoll: initiative,
                };
            }),
        };
    };

    // Tracker projection list (ADR-0028 Phases 4): prepared encounters from
    // the read model, redacted + capability-annotated per subject, then
    // enriched with bounded display/roll metadata. No raw documents are spread to the client.
    const listCombats = async (client: CombatClientLike): Promise<CombatListPayload> => {
        ensureReady();
        const subject = resolveSubject(client.userId);
        if (!subject) return { success: true, combats: [] };

        const visible = combatStore.list({ subject });
        const preferences = visible.length ? await combatStatDisplayService.resolve(client) : null;
        const adapter = visible.length ? await getAdapter((await client.getSystem()).id.toLowerCase()) : null;
        const skipDefeated = isSkipDefeatedEnabled();
        const combats = await Promise.all(visible.map(async (combat) => {
            const combatId = getDocumentId(combat);
            if (!combatId) return null;
            const prepared = combatEncounterReadModel.getOrRebuild(combatId);
            if (!prepared) return null;
            const dto = buildCombatTrackerDto(prepared, subject, { ...projectionDeps, skipDefeated });
            const managerFlag = readCombatManagerFlag(combat);
            const projected = managerFlag ? {
                ...dto,
                // Managed encounters use the separate GM-only manager routes.
                // The legacy HUD is view-only for these encounters.
                canAdvanceTurn: false,
                canRewindTurn: false,
                combatants: dto.combatants.map(row => ({ ...row, canRollInitiative: false })),
                canManage: isGM(subject) && managerFlag.status === 'active',
            } : dto;
            return enrichTrackerDto(projected, client, subject, preferences?.attributes ?? [],
                adapter, preferences?.initiativeFormula ?? null);
        }));

        return { success: true, combats: combats.filter((c): c is CombatTrackerDto =>
            c !== null && (isAssistantGM(subject) || c.combatants.length > 0)) };
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
        if (!prepared.active || !prepared.started) return false;
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

    const matchesObservation = (prepared: PreparedEncounter, observed: CombatTurnObservation): boolean =>
        prepared.active === observed.active && prepared.started === observed.started
        && prepared.round === observed.round && prepared.currentCombatantId === observed.currentCombatantId;

    const advanceTurnCore = async (
        client: CombatClientLike,
        combatId: string,
        managerCommand = false,
        observed?: CombatTurnObservation,
    ): Promise<CombatTurnSuccessPayload | CombatErrorPayload> => {
        ensureReady();
        const prepared = getPreparedEncounter(combatId);
        if (!prepared) {
            return { error: 'Combat not found', status: 404 };
        }
        const subject = resolveSubject(client.userId);
        const managed = readCombatManagerFlag(combatStore.get(combatId));
        if (managed && (!subject || !isGM(subject))) return { error: 'Gamemaster access required', status: 403 };
        if (managed && managed.status !== 'active') return { error: 'Encounter is not active', status: 409 };
        if (managed && !managerCommand) return { error: 'Use the GM Combat Manager to advance this encounter', status: 403 };
        if (!subject || !isAuthorizedForCombatTurn(prepared, subject)) {
            return { error: 'Unauthorized: You do not own the current combatant and are not a GM', status: 403 };
        }
        if (observed && !matchesObservation(prepared, observed)) {
            return { error: 'Encounter changed; review the current turn before retrying', status: 409 };
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

        await createCombatRepository(client).update(combatId, {
            round, turn,
            ...(managed && managerCommand && prepared.round === 0 ? { active: true } : {}),
        });

        return { success: true, round, turn };
    };

    // Turn rewind, GM-only. Rewinding past round 1 turn 0 returns the
    // encounter to its unstarted round-zero state.
    const advanceTurn = (client: CombatClientLike, combatId: string, managerCommand = false,
        observed?: CombatTurnObservation): Promise<CombatTurnSuccessPayload | CombatErrorPayload> =>
        managerCommand ? advanceTurnCore(client, combatId, true, observed)
            : withEncounterLock(combatId, () => advanceTurnCore(client, combatId, false, observed));

    const previousTurnCore = async (
        client: CombatClientLike,
        combatId: string,
        managerCommand = false,
        observed?: CombatTurnObservation,
    ): Promise<CombatTurnSuccessPayload | CombatErrorPayload> => {
        ensureReady();
        const prepared = getPreparedEncounter(combatId);
        if (!prepared) {
            return { error: 'Combat not found', status: 404 };
        }
        const subject = resolveSubject(client.userId);
        const managed = readCombatManagerFlag(combatStore.get(combatId));
        if (managed && (!subject || !isGM(subject))) return { error: 'Gamemaster access required', status: 403 };
        if (managed && managed.status !== 'active') return { error: 'Encounter is not active', status: 409 };
        if (managed && !managerCommand) return { error: 'Use the GM Combat Manager to rewind this encounter', status: 403 };
        if (!subject || !isAssistantGM(subject)) {
            return { error: 'Unauthorized: Only GMs can move to previous turns', status: 403 };
        }
        if (observed && !matchesObservation(prepared, observed)) {
            return { error: 'Encounter changed; review the current turn before retrying', status: 409 };
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

        await createCombatRepository(client).update(combatId, {
            round, turn,
            ...(managed && managerCommand && round === 0 ? { active: false } : {}),
        });

        return { success: true, round, turn };
    };

    // Initiative roll orchestration with adapter initiative formula fallback.
    // Authorization runs BEFORE any side effect (ADR-0028 Phase 5 preflight /
    // audit CMB-04): an unauthorized caller triggers no roll, no chat
    // message, and no document dispatch. Hidden combatants return the same
    // 404 as missing ones for non-GMs so their existence doesn't leak.
    const previousTurn = (client: CombatClientLike, combatId: string, managerCommand = false,
        observed?: CombatTurnObservation): Promise<CombatTurnSuccessPayload | CombatErrorPayload> =>
        managerCommand ? previousTurnCore(client, combatId, true, observed)
            : withEncounterLock(combatId, () => previousTurnCore(client, combatId, false, observed));

    const rollInitiativeCore = async (
        client: CombatClientLike,
        combatId: string,
        combatantId: string,
        body: CombatInitiativeRequestBody,
        managerCommand = false,
        managerInitiativeFallback?: string | null,
    ): Promise<CombatInitiativeSuccessPayload | CombatErrorPayload> => {
        ensureReady();
        const { formula, advantageMode, manualTotal, observed } = body;

        const combat = combatStore.get(combatId);
        if (!combat) return { error: 'Combat not found', status: 404 };

        const subject = resolveSubject(client.userId);
        const managed = readCombatManagerFlag(combat);
        if (managed && (!subject || !isGM(subject))) return { error: 'Gamemaster access required', status: 403 };
        if (managed && managed.status !== 'active') return { error: 'Encounter is not active', status: 409 };
        if (managed && !managerCommand) return { error: 'Use the GM Combat Manager to roll initiative', status: 403 };
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

        const sourceActor = await client.getActor(combatant.actorId);
        if (!sourceActor || sourceActor.error) {
            return {
                error: sourceActor?.error || 'Actor not found',
                status: sourceActor?.error ? 503 : 404,
            };
        }

        const actor = getPreparedActor(combatant.actorId);

        // A guarded manager batch supplies one preference snapshot for every roll.
        const initiativeFallback = managerCommand && managerInitiativeFallback !== undefined
            ? managerInitiativeFallback
            : (await combatStatDisplayService.resolve(client))?.initiativeFormula ?? null;
        const effective = effectiveInitiativeFormula(adapter, actor, initiativeFallback);
        if (observed && (observed.initiative !== (combatant.initiative ?? null)
            || observed.formula !== effective.formula)) {
            return { error: 'Initiative changed; review the current value before retrying', status: 409 };
        }
        if (manualTotal !== undefined && (!Number.isFinite(manualTotal) || advantageMode && advantageMode !== 'normal')) {
            return { error: 'Invalid manual initiative total', status: 400 };
        }
        if (manualTotal !== undefined && formula !== undefined) return { error: 'Invalid initiative request', status: 400 };
        if (manualTotal === undefined && !formula && !effective.rollAvailable) return { error: 'Initiative formula cannot resolve for this Actor; enter a value manually', status: 409 };
        if (!formula && advantageMode && advantageMode !== 'normal' && !effective.advantageAvailable) {
            return { error: 'Advantage is unavailable for this initiative formula', status: 400 };
        }
        let finalFormula = manualTotal !== undefined ? String(manualTotal) : formula || effective.formula;

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

        // Foundry's rollInitiative whispers hidden Combatant rolls to GMs.
        // A public Core chat message would reveal that hidden participant.
        const chatMessage = await client.roll(finalFormula, manualTotal !== undefined ? 'Manual Initiative' : 'Initiative', {
            speaker,
            ...(combatant.hidden ? { rollMode: 'gmroll' as const } : {}),
        });
        const total = getCombatInitiativeRollTotal(chatMessage);

        const currentId = combatEncounterReadModel.getOrRebuild(combatId)?.currentCombatantId ?? null;

        await createCombatRepository(client).updateCombatant(combatId, combatantId, { initiative: total });
        if (!managerCommand && currentId && (combat.round ?? 0) > 0) {
            const reordered = combatEncounterReadModel.getOrRebuild(combatId);
            const newIndex = reordered?.rows.findIndex(row => row.id === currentId) ?? -1;
            if (newIndex >= 0 && combatStore.get(combatId)?.turn !== newIndex) {
                await createCombatRepository(client).update(combatId, { turn: newIndex });
            }
        }

        return { success: true, initiative: total };
    };

    const rollInitiative = (client: CombatClientLike, combatId: string, combatantId: string,
        body: CombatInitiativeRequestBody, managerCommand = false,
        managerInitiativeFallback?: string | null): Promise<CombatInitiativeSuccessPayload | CombatErrorPayload> =>
        managerCommand ? rollInitiativeCore(client, combatId, combatantId, body, true, managerInitiativeFallback)
            : withEncounterLock(combatId, () => rollInitiativeCore(client, combatId, combatantId, body));

    return {
        listCombats,
        advanceTurn,
        previousTurn,
        rollInitiative
    };
}
