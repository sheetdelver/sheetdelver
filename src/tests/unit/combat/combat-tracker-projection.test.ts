import { strict as assert } from 'node:assert';
import { buildCombatTrackerDto } from '@server/services/combats/CombatTrackerProjection';
import type { PreparedEncounter } from '@server/core/documents/encounters/CombatEncounterReadModel';
import {
    FoundryUserRole,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';

/**
 * ADR-0028 Phase 4: subject-specific tracker projection. Hidden-row
 * redaction happens after current-turn identity resolution (CMB-01), hidden
 * current combatants are never identified to non-GM viewers, and
 * capabilities are server-computed per subject.
 */

const gm: DocumentAccessSubject = { userId: 'gm-1', role: FoundryUserRole.GAMEMASTER };
const player: DocumentAccessSubject = { userId: 'p-1', role: FoundryUserRole.PLAYER };

function preparedFixture(overrides: Partial<PreparedEncounter> = {}): PreparedEncounter {
    return {
        id: 'combat-1',
        active: true,
        started: true,
        round: 2,
        turn: 1,
        currentCombatantId: 'c-hidden',
        rows: [
            {
                id: 'c-player', actorId: 'actor-player', tokenId: null, name: 'Hero', img: 'hero.png',
                initiative: 20, hidden: false, defeated: false, groupId: null,
            },
            {
                id: 'c-hidden', actorId: 'actor-gm', tokenId: null, name: 'Lurker', img: null,
                initiative: 15, hidden: true, defeated: false, groupId: null,
            },
            {
                id: 'c-npc', actorId: 'actor-npc', tokenId: null, name: 'Goblin', img: 'goblin.png',
                initiative: 10, hidden: false, defeated: true, groupId: null,
            },
        ],
        groups: [],
        ...overrides,
    };
}

// Player owns only their own actor.
const deps = {
    canWriteActor: (actorId: string, subject: DocumentAccessSubject) =>
        subject.userId === 'p-1' && actorId === 'actor-player',
};

export function run() {
    runGmProjection();
    runPlayerRedaction();
    runHiddenCurrentCombatant();
    runVisibleCurrentCapabilities();
    runRoundZero();
    runHiddenPrivacy();
    console.log('  - CombatTrackerProjection: all checks passed');
}

function runGmProjection() {
    const dto = buildCombatTrackerDto(preparedFixture(), gm, deps);

    assert.equal(dto.combatants.length, 3, 'GM sees hidden rows');
    assert.equal(dto.combatants[1].hidden, true, 'hidden rows arrive flagged for GMs');
    assert.equal(dto.currentCombatantId, 'c-hidden', 'GM sees the hidden current identity');
    assert.equal(dto.combatants[1].isCurrent, true);
    assert.equal(dto.canAdvanceTurn, true);
    assert.equal(dto.canRewindTurn, true);
    assert.ok(dto.combatants.every(row => row.canRollInitiative), 'GM can roll for every row');
    assert.equal(dto.combatants[2].defeated, true);
    const skipDefeated = buildCombatTrackerDto(preparedFixture(), gm, { ...deps, skipDefeated: true });
    assert.equal(skipDefeated.nextShownCombatantId, 'c-player',
        'GM preview follows Foundry skip-defeated policy when enabled');
}

function runPlayerRedaction() {
    const dto = buildCombatTrackerDto(preparedFixture(), player, deps);

    assert.deepEqual(dto.combatants.map(r => r.id), ['c-player', 'c-npc'], 'hidden rows are pruned for players');
    assert.equal(dto.combatants[0].canRollInitiative, true, 'player can roll for their owned actor');
    assert.equal(dto.combatants[1].canRollInitiative, false, 'player cannot roll for the NPC');
    assert.ok(dto.combatants.every(row => !('actor' in row)), 'projection never exposes raw Actor payloads');
}

function runHiddenCurrentCombatant() {
    const dto = buildCombatTrackerDto(preparedFixture(), player, deps);

    // The current combatant is hidden from this viewer: identity must not
    // leak, and no visible row may claim the highlight (CMB-01).
    assert.equal(dto.currentCombatantId, null);
    assert.equal('hasHiddenCurrentCombatant' in dto, false);
    assert.ok(dto.combatants.every(row => !row.isCurrent), 'no visible row is marked current');
    assert.equal(dto.canAdvanceTurn, false, 'players cannot advance through a hidden current combatant');
}

function runVisibleCurrentCapabilities() {
    const prepared = preparedFixture({ turn: 0, currentCombatantId: 'c-player' });

    const playerDto = buildCombatTrackerDto(prepared, player, deps);
    assert.equal(playerDto.currentCombatantId, 'c-player');
    assert.equal(playerDto.combatants[0].isCurrent, true);
    assert.equal(playerDto.canAdvanceTurn, true, 'owner of the visible current combatant can advance');
    assert.equal(playerDto.canRewindTurn, false, 'rewind stays GM-only');

    // Same encounter, but the current combatant belongs to someone else.
    const otherCurrent = preparedFixture({ turn: 2, currentCombatantId: 'c-npc' });
    const bystanderDto = buildCombatTrackerDto(otherCurrent, player, deps);
    assert.equal(bystanderDto.canAdvanceTurn, false, 'non-owner cannot advance another\'s turn');
}

function runRoundZero() {
    const prepared = preparedFixture({
        started: false, round: 0, turn: null, currentCombatantId: null,
    });

    const gmDto = buildCombatTrackerDto(prepared, gm, deps);
    assert.equal(gmDto.started, false);
    assert.equal(gmDto.round, 0);
    assert.equal(gmDto.currentCombatantId, null);
    assert.equal(gmDto.canAdvanceTurn, true, 'GM can start (advance) an unstarted encounter');
    assert.equal(gmDto.canRewindTurn, false, 'nothing to rewind before the encounter starts');
    assert.equal(gmDto.combatants.length, 3, 'GM sees the full forming roster pre-combat');

    // Pre-combat redaction: players receive only their own rollable rows, so
    // they can pre-roll initiative without the forming roster leaking.
    const playerDto = buildCombatTrackerDto(prepared, player, deps);
    assert.deepEqual(playerDto.combatants.map(r => r.id), ['c-player'],
        'unstarted encounters expose only the subject\'s rollable rows');
    assert.equal(playerDto.combatants[0].canRollInitiative, true);
    assert.equal(playerDto.canAdvanceTurn, false, 'starting an encounter is a GM action');
    assert.ok(playerDto.combatants.every(row => !row.isCurrent));

    const persistedTurnZero = buildCombatTrackerDto(preparedFixture({
        started: false, round: 0, turn: 0, currentCombatantId: 'c-player',
    }), player, deps);
    assert.equal(persistedTurnZero.currentCombatantId, null);
    assert.equal(persistedTurnZero.canAdvanceTurn, false);

    // A player with no combatant in the forming encounter receives no rows —
    // the encounter stays invisible to them until it starts.
    const bystander = { userId: 'p-2', role: FoundryUserRole.PLAYER };
    const bystanderDto = buildCombatTrackerDto(prepared, bystander, deps);
    assert.equal(bystanderDto.combatants.length, 0);

    const ownedHidden = preparedFixture({ rows: [
        { ...prepared.rows[0], hidden: true },
    ], currentCombatantId: 'c-player' });
    const hiddenDto = buildCombatTrackerDto(ownedHidden, player, deps);
    assert.deepEqual(hiddenDto.combatants, []);
    assert.equal(hiddenDto.currentCombatantId, null);
    assert.equal('hasHiddenCurrentCombatant' in hiddenDto, false);
}

function runHiddenPrivacy() {
    const base = preparedFixture({ currentCombatantId: 'c-player', turn: 0 });
    const hidden = base.rows[1];
    const visible = base.rows.filter(row => !row.hidden);
    for (const rows of [
        [hidden, ...visible], [visible[0], hidden, visible[1]], [...visible, hidden],
        [visible[0], hidden, { ...hidden, id: 'c-hidden-2' }, visible[1]],
    ]) {
        const dto = buildCombatTrackerDto({ ...base, rows }, player, deps);
        assert.deepEqual(dto.combatants.map(row => row.id), ['c-player', 'c-npc']);
        assert.equal(dto.nextShownCombatantId, 'c-npc');
        assert.equal(JSON.stringify(dto).includes('c-hidden'), false);
    }
    const hiddenOwned = buildCombatTrackerDto({ ...base, rows: [{ ...base.rows[0], hidden: true }],
        currentCombatantId: 'c-player' }, player, deps);
    assert.deepEqual(hiddenOwned.combatants, []);
    assert.equal(hiddenOwned.currentCombatantId, null);
    assert.equal(hiddenOwned.nextShownCombatantId, null);
    assert.equal(JSON.stringify(hiddenOwned).includes('c-player'), false);
    const gmDto = buildCombatTrackerDto(base, gm, deps);
    assert.equal(gmDto.combatants[1].name, 'Lurker');
    assert.equal(gmDto.combatants[1].hidden, true);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('combat-tracker-projection.test.ts passed');
}
