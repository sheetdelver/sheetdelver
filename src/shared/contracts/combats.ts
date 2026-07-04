/**
 * Combat tracker wire contract (ADR-0028 Phase 4).
 *
 * `/api/combats` returns explicit, whitelisted tracker projections built from
 * the backend encounter read model — never raw Combat/Combatant/Actor
 * documents. Ordering, current-turn identity, and action capabilities are
 * server-computed; the client renders them without reconstruction.
 */

/**
 * Minimal actor payload for the initiative roll dialog. Present only on rows
 * the requesting user is allowed to roll for (i.e. actors they could read in
 * full anyway); never carries ownership maps.
 */
export interface CombatTrackerActorDto {
    id: string;
    name?: string | null;
    img?: string | null;
    system?: Record<string, unknown>;
}

export interface CombatTrackerCombatantDto {
    id: string;
    actorId: string | null;
    /** Display identity: combatant fields first, actor fallback (server-resolved). */
    name: string | null;
    img: string | null;
    initiative: number | null;
    defeated: boolean;
    /** Hidden rows are pruned for players; GM viewers receive them flagged. */
    hidden: boolean;
    isCurrent: boolean;
    canRollInitiative: boolean;
    actor: CombatTrackerActorDto | null;
}

export interface CombatTrackerDto {
    id: string;
    active: boolean;
    /** Foundry semantics: started === round > 0. Round-zero state is explicit. */
    started: boolean;
    round: number;
    /**
     * Stable id of the combatant whose turn it is, or null when unstarted or
     * when the current combatant is hidden from this viewer (see
     * `hasHiddenCurrentCombatant`). Never a positional index.
     */
    currentCombatantId: string | null;
    hasHiddenCurrentCombatant: boolean;
    canAdvanceTurn: boolean;
    canRewindTurn: boolean;
    combatants: CombatTrackerCombatantDto[];
}

export interface CombatListPayload {
    success: boolean;
    combats: CombatTrackerDto[];
}

export interface CombatTurnSuccessPayload {
    success: true;
    round: number;
    turn: number;
}

export interface CombatInitiativeSuccessPayload {
    success: true;
    initiative: number;
}

export interface CombatInitiativeRequestBody {
    formula?: string;
    advantageMode?: 'advantage' | 'disadvantage' | 'normal';
}

export interface CombatErrorPayload {
    error: string;
    status: number;
}
