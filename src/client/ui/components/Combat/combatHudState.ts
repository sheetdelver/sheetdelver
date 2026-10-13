import type { CombatTrackerDto } from '@shared/contracts/combats';

/** A hidden-only encounter is omitted by the player projection; never show an empty slot. */
export function selectActiveCombats(combats: CombatTrackerDto[] | null | undefined): CombatTrackerDto[] {
    return (combats || []).filter(combat => combat.active && combat.combatants.length > 0);
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
