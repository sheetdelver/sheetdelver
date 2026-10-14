import type { PreparedEncounter, PreparedEncounterRow } from '@server/core/documents/encounters/CombatEncounterReadModel';
import type { CombatManagerFlag } from './combatManagerFlag';

/** Managed policy only. The shared read model retains full native indexes. */
export function isManagedTurnEligible(row: PreparedEncounterRow, skipDefeated = false): boolean {
    return row.initiative !== null && Number.isFinite(row.initiative) && (!skipDefeated || !row.defeated);
}

export function managedCurrentCombatantId(prepared: PreparedEncounter, flag: CombatManagerFlag): string | null {
    if (!prepared.started || flag.turnPause) return null;
    const row = prepared.rows.find(candidate => candidate.id === prepared.currentCombatantId);
    return row && isManagedTurnEligible(row) ? row.id : null;
}

/** A saved score/id is the pre-clear position, not the pending row's new index. */
function compareAnchor(row: PreparedEncounterRow, anchor: NonNullable<CombatManagerFlag['turnPause']>): number {
    return anchor.initiative - row.initiative! || (row.id === anchor.combatantId ? 0 : row.id > anchor.combatantId ? 1 : -1);
}

export function resolveManagedTurn(prepared: PreparedEncounter, flag: CombatManagerFlag,
    direction: 'next' | 'previous', skipDefeated: boolean): { round: number; turn: number | null } | null {
    const eligible = prepared.rows.map((row, index) => ({ row, index }))
        .filter(({ row }) => isManagedTurnEligible(row, skipDefeated));
    if (!eligible.length) return null;
    if (!prepared.started) return direction === 'next'
        ? { round: 1, turn: eligible[0].index } : { round: 0, turn: null };
    const pause = flag.turnPause;
    if (direction === 'next') {
        const following = eligible.find(({ row, index }) => pause
            ? row.id !== pause.combatantId && compareAnchor(row, pause) > 0
            : index > (prepared.turn ?? -1));
        return following ? { round: prepared.round, turn: following.index }
            : { round: prepared.round + 1, turn: eligible[0].index };
    }
    const preceding = eligible.filter(({ row, index }) => pause
        ? row.id !== pause.combatantId && compareAnchor(row, pause) < 0
        : index < (prepared.turn ?? 0)).at(-1);
    if (preceding) return { round: prepared.round, turn: preceding.index };
    return prepared.round > 1 ? { round: prepared.round - 1, turn: eligible.at(-1)!.index }
        : { round: 0, turn: null };
}
