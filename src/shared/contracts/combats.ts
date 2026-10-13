/**
 * Combat tracker wire contract (ADR-0028 Phase 4).
 *
 * `/api/combats` returns explicit, whitelisted tracker projections built from
 * the backend encounter read model — never raw Combat/Combatant/Actor
 * documents. Ordering, current-turn identity, and action capabilities are
 * server-computed; the client renders them without reconstruction.
 */

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
    isOwned: boolean;
    canOpenActor: boolean;
    /** Base Actor stats are unavailable for an unlinked scene Token. */
    statSource: 'world-actor' | 'unlinked-token' | null;
    stats: { title: string; value: string | number; subValue?: string | number }[];
    initiativeRoll: {
        formula: string;
        source: 'module' | 'gm' | 'core';
        rollAvailable: boolean;
        advantageAvailable: boolean;
    } | null;
}

export interface CombatTrackerDto {
    id: string;
    active: boolean;
    /** Foundry semantics: started === round > 0. Round-zero state is explicit. */
    started: boolean;
    round: number;
    /**
     * Stable id of the combatant whose turn it is, or null when unstarted or
     * when the current combatant is not visible to this viewer. Never a
     * positional index or a hidden-participant marker.
     */
    currentCombatantId: string | null;
    /** Next row in this viewer's authorized visible order, not a secret turn slot. */
    nextShownCombatantId: string | null;
    canAdvanceTurn: boolean;
    canRewindTurn: boolean;
    canManage: boolean;
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

/** State observed by the HUD before requesting an ordinary encounter turn. */
export interface CombatTurnObservation {
    active: boolean;
    started: boolean;
    round: number;
    currentCombatantId: string | null;
}

export interface CombatInitiativeSuccessPayload {
    success: true;
    initiative: number;
}

export interface CombatInitiativeRequestBody {
    advantageMode?: 'advantage' | 'disadvantage' | 'normal';
    /** A numeric final total, never a formula override or die face. */
    manualTotal?: number;
    observed?: {
        initiative: number | null;
        formula: string;
    };
    /** Internal manager command only; never accepted on ordinary routes. */
    formula?: string;
}

export interface CombatErrorPayload {
    error: string;
    status: number;
}
