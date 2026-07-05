import { strict as assert } from 'node:assert';
import {
    buildCombatCarousel,
    composeInitiativeFormula,
    currentTurnName,
    isCarouselDivider,
    resolveSelectedCombat,
    selectActiveCombats,
} from '@client/ui/components/Combat/combatHudState';
import type { CombatTrackerDto, CombatTrackerCombatantDto } from '@shared/contracts/combats';

/**
 * ADR-0028 Phase 6 client tests: the CombatHUD view-model consumes the server
 * tracker projection without reconstructing domain logic — these cover the
 * visibility policy, stable-id selection, carousel composition around the
 * server-provided current row, hidden-current naming, round-zero/pre-combat
 * states, and initiative formula composition.
 */

function row(id: string, overrides: Partial<CombatTrackerCombatantDto> = {}): CombatTrackerCombatantDto {
    return {
        id,
        actorId: `actor-${id}`,
        name: `Name ${id}`,
        img: null,
        initiative: null,
        defeated: false,
        hidden: false,
        isCurrent: false,
        canRollInitiative: false,
        actor: null,
        ...overrides,
    };
}

function tracker(id: string, overrides: Partial<CombatTrackerDto> = {}): CombatTrackerDto {
    return {
        id,
        active: true,
        started: true,
        round: 1,
        currentCombatantId: null,
        hasHiddenCurrentCombatant: false,
        canAdvanceTurn: false,
        canRewindTurn: false,
        combatants: [],
        ...overrides,
    };
}

export function run() {
    runVisibilityPolicy();
    runStableSelection();
    runCarouselComposition();
    runCurrentTurnNaming();
    runInitiativeFormula();
    console.log('  - CombatHUD view-model: all checks passed');
}

function runVisibilityPolicy() {
    const started = tracker('c-started', { combatants: [row('r1')] });
    const inactive = tracker('c-inactive', { active: false, combatants: [row('r1')] });
    // Pre-combat: unstarted encounters show only when the projection returned
    // rows for this viewer (their rollable combatants / GM roster).
    const forming = tracker('c-forming', { started: false, round: 0, combatants: [row('r1', { canRollInitiative: true })] });
    const formingInvisible = tracker('c-forming-empty', { started: false, round: 0, combatants: [] });
    // Started encounters render even when every row was redacted away.
    const startedEmpty = tracker('c-started-empty', { combatants: [] });

    assert.deepEqual(
        selectActiveCombats([started, inactive, forming, formingInvisible, startedEmpty]).map(c => c.id),
        ['c-started', 'c-forming', 'c-started-empty'],
        'inactive always hidden; unstarted hidden unless the viewer has rows',
    );
    assert.deepEqual(selectActiveCombats(undefined), [], 'missing list yields no encounters');
}

function runStableSelection() {
    const a = tracker('combat-a', { combatants: [row('r1')] });
    const b = tracker('combat-b', { combatants: [row('r2')] });

    assert.equal(resolveSelectedCombat([], null), null, 'no encounters, nothing to select');

    // Default: first encounter.
    assert.equal(resolveSelectedCombat([a, b], null)?.combat.id, 'combat-a');

    // Selection survives list reordering (stable id, not index).
    const reordered = resolveSelectedCombat([b, a], 'combat-a');
    assert.equal(reordered?.combat.id, 'combat-a');
    assert.equal(reordered?.index, 1);

    // Selection gone (encounter ended) — fall back to the first.
    const fallback = resolveSelectedCombat([b], 'combat-a');
    assert.equal(fallback?.combat.id, 'combat-b');
    assert.equal(fallback?.index, 0);
}

function runCarouselComposition() {
    const combat = tracker('c', {
        combatants: [
            row('r1'),
            row('r2', { isCurrent: true }),
            row('r3'),
        ],
        currentCombatantId: 'r2',
    });

    const { items, currentIndex } = buildCombatCarousel(combat);
    assert.equal(currentIndex, 1);
    assert.deepEqual(
        items.map(item => (isCarouselDivider(item) ? 'divider' : item.id)),
        ['r2', 'r3', 'divider', 'r1'],
        'current row leads; acted rows trail the round divider',
    );

    // No visible current row (round zero, or hidden current): everything is
    // upcoming and nothing renders as acted.
    const noCurrent = tracker('c0', {
        started: false,
        round: 0,
        combatants: [row('r1'), row('r2')],
    });
    const preCombat = buildCombatCarousel(noCurrent);
    assert.equal(preCombat.currentIndex, -1);
    assert.deepEqual(
        preCombat.items.map(item => (isCarouselDivider(item) ? 'divider' : item.id)),
        ['r1', 'r2', 'divider'],
    );
}

function runCurrentTurnNaming() {
    const visible = tracker('c', {
        combatants: [row('r1', { isCurrent: true, name: 'Goblin King' })],
        currentCombatantId: 'r1',
    });
    assert.equal(currentTurnName(visible), 'Goblin King');

    const nameless = tracker('c', {
        combatants: [row('r1', { isCurrent: true, name: null })],
        currentCombatantId: 'r1',
    });
    assert.equal(currentTurnName(nameless), 'Unknown');

    // Server redacted the current combatant: identity must not be guessed at.
    const hiddenCurrent = tracker('c', {
        combatants: [row('r1'), row('r2')],
        currentCombatantId: null,
        hasHiddenCurrentCombatant: true,
    });
    assert.equal(currentTurnName(hiddenCurrent), 'Hidden combatant');

    const preStart = tracker('c', { started: false, round: 0, combatants: [row('r1')] });
    assert.equal(currentTurnName(preStart), 'Unknown');
}

function runInitiativeFormula() {
    assert.equal(composeInitiativeFormula({}), undefined, 'no manual value defers to the server formula');
    assert.equal(
        composeInitiativeFormula({ abilityBonus: 3 }),
        undefined,
        'bonuses alone never override the adapter formula',
    );
    assert.equal(composeInitiativeFormula({ manualValue: 12 }), '12');
    assert.equal(composeInitiativeFormula({ manualValue: 12, abilityBonus: 2, itemBonus: 1 }), '12+3');
    assert.equal(composeInitiativeFormula({ manualValue: 12, abilityBonus: -2 }), '12-2');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('combat-hud-state.test.ts passed');
}
