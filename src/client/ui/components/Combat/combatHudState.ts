import type { CombatTrackerDto, CombatTrackerCombatantDto } from '@shared/contracts/combats';

/** A hidden-only encounter is omitted by the player projection; never show an empty slot. */
export function selectActiveCombats(combats: CombatTrackerDto[] | null | undefined): CombatTrackerDto[] {
    return (combats || []).filter(combat => (combat.combatants.length > 0 || !!combat.initiativeCandidates?.length)
        && (combat.active || (!combat.started && combat.playerInitiative?.open === true)));
}

export interface SelectedCombat {
    combat: CombatTrackerDto;
    index: number;
}

/** Keep the chosen Combat by ID without activating another Foundry encounter. */
export function resolveSelectedCombat(activeCombats: CombatTrackerDto[],
    selectedCombatId: string | null): SelectedCombat | null {
    if (!activeCombats.length) return null;
    const index = selectedCombatId ? activeCombats.findIndex(combat => combat.id === selectedCombatId) : -1;
    return index >= 0 ? { combat: activeCombats[index], index }
        : { combat: activeCombats[0], index: 0 };
}

export function ownedCombatants(combat: CombatTrackerDto | null): CombatTrackerCombatantDto[] {
    const rows = [...(combat?.combatants ?? []), ...(combat?.initiativeCandidates ?? [])];
    return [...new Map(rows.filter(row => row.isOwned).map(row => [row.id, row])).values()];
}

export function ownedInitiativeCandidates(combat: CombatTrackerDto | null): CombatTrackerCombatantDto[] {
    return ownedCombatants(combat).filter(row => !row.hidden && row.initiative === null && row.canRollInitiative && row.initiativeRoll);
}

export function selectOwnedCombatant(combat: CombatTrackerDto | null, manualId?: string | null): CombatTrackerCombatantDto | null {
    const owned = ownedCombatants(combat);
    return owned.find(row => row.id === manualId) ?? owned.find(row => row.isCurrent)
        ?? ownedInitiativeCandidates(combat)[0] ?? owned[0] ?? null;
}
