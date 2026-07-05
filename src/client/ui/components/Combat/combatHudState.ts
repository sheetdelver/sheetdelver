import type { CombatTrackerDto, CombatTrackerCombatantDto } from '@shared/contracts/combats';

/**
 * Pure CombatHUD view-model helpers (ADR-0028 Phase 6). Everything here
 * derives presentation state from the server tracker projection without
 * reconstructing domain logic — ordering, current identity, redaction, and
 * capabilities arrive precomputed in `CombatTrackerDto`. Kept React-free so
 * the behavior is unit-testable in node (ADR-0024/0025 client-test pattern).
 */

export interface CombatCarouselDivider {
    isDivider: true;
    id: string;
}

export type CombatCarouselItem = CombatTrackerCombatantDto | CombatCarouselDivider;

export function isCarouselDivider(item: CombatCarouselItem): item is CombatCarouselDivider {
    return 'isDivider' in item;
}

/**
 * HUD visibility policy: started encounters render the full tracker;
 * unstarted active encounters surface only when the server projection
 * returned rows for this viewer (players: their rollable combatants for the
 * pre-combat state; GMs: the forming roster).
 */
export function selectActiveCombats(combats: CombatTrackerDto[] | null | undefined): CombatTrackerDto[] {
    return (combats || []).filter(c => c.active && (c.started || c.combatants.length > 0));
}

export interface SelectedCombat {
    combat: CombatTrackerDto;
    index: number;
}

/**
 * Stable-id encounter selection: keep the chosen encounter wherever it moves
 * in the list; fall back to the first active encounter when the selection is
 * gone. Returns null only when no encounters are visible.
 */
export function resolveSelectedCombat(
    activeCombats: CombatTrackerDto[],
    selectedCombatId: string | null,
): SelectedCombat | null {
    if (activeCombats.length === 0) return null;
    const index = selectedCombatId
        ? activeCombats.findIndex(c => c.id === selectedCombatId)
        : -1;
    return index >= 0
        ? { combat: activeCombats[index], index }
        : { combat: activeCombats[0], index: 0 };
}

/**
 * Display name for the combatant whose turn it is. A current combatant the
 * server redacted (hidden from this viewer) reads as "Hidden combatant"
 * rather than leaking anything or pretending nobody has the turn.
 */
export function currentTurnName(combat: CombatTrackerDto): string {
    const current = combat.combatants.find(row => row.isCurrent);
    if (current) return current.name ?? 'Unknown';
    return combat.hasHiddenCurrentCombatant ? 'Hidden combatant' : 'Unknown';
}

export interface CombatCarousel {
    items: CombatCarouselItem[];
    /** Index of the current row within `combat.combatants`, or -1. */
    currentIndex: number;
}

/**
 * Carousel composition: server order rotated so the current turn leads,
 * acted rows trail behind the round divider. With no visible current row
 * (pre-start, or hidden current) every row is upcoming.
 */
export function buildCombatCarousel(combat: CombatTrackerDto): CombatCarousel {
    const rows = combat.combatants;
    const currentIndex = rows.findIndex(row => row.isCurrent);
    const splitIndex = currentIndex >= 0 ? currentIndex : 0;
    return {
        items: [
            ...rows.slice(splitIndex),
            { isDivider: true, id: 'round-divider' },
            ...rows.slice(0, splitIndex),
        ],
        currentIndex,
    };
}

export interface InitiativeRollOptions {
    manualValue?: number;
    abilityBonus?: number;
    itemBonus?: number;
    talentBonus?: number;
}

/**
 * Initiative request formula: a manual value carries the dialog's edited
 * bonuses; without one the request sends no formula and the server applies
 * the system adapter's initiative formula.
 */
export function composeInitiativeFormula(options: InitiativeRollOptions): string | undefined {
    if (options.manualValue === undefined) return undefined;
    const totalBonus = (options.abilityBonus || 0) + (options.itemBonus || 0) + (options.talentBonus || 0);
    const suffix = totalBonus > 0 ? `+${totalBonus}` : totalBonus < 0 ? `${totalBonus}` : '';
    return `${options.manualValue}${suffix}`;
}
