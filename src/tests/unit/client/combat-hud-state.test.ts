import { strict as assert } from 'node:assert';
import { resolveSelectedCombat, selectActiveCombats, ownedCombatants, ownedInitiativeCandidates, selectOwnedCombatant } from '@client/ui/components/Combat/combatHudState';
import { runInitiativeSequence, type InitiativeOutcome } from '@client/ui/components/Combat/initiativeSequence';
import { ApiError } from '@client/ui/api/http';
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

export async function run() {
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
    const first = { ...row('one'), isOwned: true, canRollInitiative: true,
        initiativeRoll: { formula: '1d20+0', source: 'module' as const, rollAvailable: true, advantageAvailable: true } };
    const second = { ...first, id: 'two', actorId: 'actor-two' };
    const ownTurn = { ...row('current'), isOwned: true, isCurrent: true, initiative: 12 };
    const multiple = tracker('multi', { combatants: [ownTurn], initiativeCandidates: [first, second],
        playerInitiative: { open: true, generation: 'phase' } });
    assert.equal(selectOwnedCombatant(multiple)?.id, 'current');
    assert.equal(selectOwnedCombatant(multiple, 'two')?.id, 'two');
    assert.equal(selectOwnedCombatant({ ...multiple, combatants: [] })?.id, 'one');
    assert.equal(ownedInitiativeCandidates(multiple).length, 2);
    assert.equal(ownedInitiativeCandidates({ ...multiple, initiativeCandidates: [first] }).length, 1);
    assert.equal(ownedInitiativeCandidates({ ...multiple, initiativeCandidates: [] }).length, 0);
    assert.equal(ownedCombatants({ ...multiple, combatants: [first], initiativeCandidates: [first] }).length, 1);
    for (const target of [{ ...first, hidden: true }, { ...first, isOwned: false }, { ...first, initiative: 0 }, { ...first, canRollInitiative: false }]) {
        assert.deepEqual(ownedInitiativeCandidates({ ...multiple, combatants: [], initiativeCandidates: [target] }), []);
    }
    for (const failure of [new ApiError('chat exists, no score', 502, 'ROLL_NOT_APPLIED'),
        new ApiError('unknown', 502, 'ROLL_OUTCOME_UNKNOWN'), new TypeError('network timeout'),
        new ApiError('applied, sync uncertain', 409, 'TURN_SYNC_UNKNOWN')]) {
        const submitted: string[] = [], outcomes: InitiativeOutcome[] = [];
        await runInitiativeSequence([first, second], 'phase', {
            isCurrent: () => true, readCombat: async () => multiple,
            submit: async target => { submitted.push(target.id); throw failure; }, report: outcome => outcomes.push(outcome),
        });
        assert.deepEqual(submitted, ['one'], 'failure/uncertainty stops dispatch without replay');
        assert.equal(outcomes.at(-1)?.state, failure instanceof ApiError && failure.code === 'ROLL_NOT_APPLIED' ? 'failed'
            : failure instanceof ApiError && failure.code === 'TURN_SYNC_UNKNOWN' ? 'applied' : 'unknown');
    }
    let current = true;
    const sent: string[] = [], outcomes: InitiativeOutcome[] = [];
    await runInitiativeSequence([first, second], 'phase', {
        isCurrent: () => current, readCombat: async () => multiple,
        submit: async target => { sent.push(target.id); current = false; return { success: true, initiative: 10 }; },
        report: outcome => outcomes.push(outcome),
    });
    assert.deepEqual(sent, ['one'], 'close/retirement during request stops remaining rolls');
    assert.deepEqual(outcomes.map(outcome => outcome.state), ['running'], 'late callbacks cannot update retired view');
    for (const changed of [{ ...first, actorId: 'different-owned' }, { ...first, actorId: 'unowned', isOwned: false },
        { ...first, hidden: true }, { ...first, initiative: 10 }]) {
        const applied: string[] = [];
        const snapshot = { ...multiple, initiativeCandidates: [changed, second, { ...first, id: 'late' }] };
        await runInitiativeSequence([first, second], 'phase', { isCurrent: () => true, readCombat: async () => snapshot,
            submit: async target => { applied.push(target.id); return { success: true, initiative: 12 }; }, report: () => {} });
        assert.deepEqual(applied, ['two'], 'changed identities/ownership/scores are skipped, new arrivals never appended');
    }
    let phaseWrites = 0;
    await runInitiativeSequence([first], 'phase', { isCurrent: () => true,
        readCombat: async () => ({ ...multiple, playerInitiative: undefined }),
        submit: async () => { phaseWrites++; return { success: true, initiative: 1 }; }, report: () => {} });
    assert.equal(phaseWrites, 0);
    const concurrentSnapshot = structuredClone(multiple);
    const dispatched: string[] = [], concurrencyOutcomes: InitiativeOutcome[] = [];
    await runInitiativeSequence([first, second], 'phase', {
        isCurrent: () => true, readCombat: async () => concurrentSnapshot,
        submit: async target => {
            dispatched.push(target.id);
            // A co-owner scores the second Actor while the first roll is in flight.
            concurrentSnapshot.initiativeCandidates![1].initiative = 8;
            return { success: true, initiative: 12 };
        }, report: outcome => concurrencyOutcomes.push(outcome),
    });
    assert.deepEqual(dispatched, ['one']);
    assert.deepEqual(concurrencyOutcomes.map(outcome => outcome.state), ['running', 'applied', 'skipped']);
    const mutableTargets = structuredClone([first, second]);
    const mutatedWrites: string[] = [];
    await runInitiativeSequence(mutableTargets, 'phase', {
        isCurrent: () => true,
        readCombat: async () => {
            // Even an upstream in-place mutation cannot change the confirmed Actor.
            mutableTargets[1].actorId = 'replacement-owned';
            return { ...multiple, initiativeCandidates: mutableTargets };
        },
        submit: async target => { mutatedWrites.push(target.id); return { success: true, initiative: 10 }; },
        report: () => {},
    });
    assert.deepEqual(mutatedWrites, ['one'], 'confirmed target identities are captured before any asynchronous read');
    let duringRefresh = true;
    await runInitiativeSequence([first], 'phase', {
        isCurrent: () => duringRefresh,
        readCombat: async () => { duringRefresh = false; return multiple; },
        submit: async () => { throw new Error('must not dispatch after retirement'); },
        report: () => { throw new Error('must not report after retirement'); },
    });
    console.log('  - CombatHUD view-model: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().catch(error => { console.error(error); process.exitCode = 1; });
}
