import { strict as assert } from 'node:assert';
import { resolveSelectedCombat, selectActiveCombats } from '@client/ui/components/Combat/combatHudState';
import type { CombatTrackerDto, CombatTrackerCombatantDto } from '@shared/contracts/combats';

function row(id: string): CombatTrackerCombatantDto {
    return { id, actorId: `actor-${id}`, name: `Name ${id}`, img: null, initiative: null,
        defeated: false, hidden: false, isCurrent: false, canRollInitiative: false,
        isOwned: false, canOpenActor: false, statSource: null, stats: [],
        initiativeRoll: null };
}

function tracker(id: string, overrides: Partial<CombatTrackerDto> = {}): CombatTrackerDto {
    return { id, active: true, started: true, round: 1, currentCombatantId: null,
        nextShownCombatantId: null, canAdvanceTurn: false, canRewindTurn: false,
        canManage: false, combatants: [], ...overrides };
}

export function run() {
    const a = tracker('a', { combatants: [row('one')] });
    const b = tracker('b', { combatants: [row('two')] });
    const forming = tracker('forming', { started: false, round: 0, combatants: [row('three')] });
    const hiddenOnly = tracker('hidden-only');
    const inactive = tracker('inactive', { active: false, combatants: [row('four')] });
    const initiative = tracker('initiative', { active: false, started: false, round: 0,
        playerInitiative: { open: true, generation: 'phase-one' }, combatants: [row('owned')] });
    assert.deepEqual(selectActiveCombats([a, forming, hiddenOnly, inactive, b]).map(combat => combat.id),
        ['a', 'forming', 'b']);
    assert.deepEqual(selectActiveCombats([inactive, initiative]).map(combat => combat.id), ['initiative']);
    const pendingOnly = tracker('pending-only', { active: false, started: false, round: 0,
        playerInitiative: { open: true, generation: 'phase-two' }, initiativeCandidates: [row('pending')] });
    assert.deepEqual(selectActiveCombats([pendingOnly]).map(combat => combat.id), ['pending-only'],
        'own initiative prompt retains an encounter even without turn-roster rows');
    assert.deepEqual(selectActiveCombats([{ ...pendingOnly, initiativeCandidates: [] }]), [],
        'empty/hidden-only phase never exposes an encounter slot');
    assert.deepEqual(selectActiveCombats(undefined), []);
    assert.equal(resolveSelectedCombat([], null), null);
    assert.equal(resolveSelectedCombat([a, b], null)?.combat.id, 'a');
    assert.equal(resolveSelectedCombat([b, a], 'a')?.index, 1);
    assert.equal(resolveSelectedCombat([b], 'a')?.combat.id, 'b');
    console.log('  - CombatHUD view-model: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('combat-hud-state.test.ts passed');
}
