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
    console.log('  - CombatTrackerProjection: all checks passed');
}

function runGmProjection() {
    const dto = buildCombatTrackerDto(preparedFixture(), gm, deps);

    assert.equal(dto.combatants.length, 3, 'GM sees hidden rows');
    assert.equal(dto.combatants[1].hidden, true, 'hidden rows arrive flagged for GMs');
    assert.equal(dto.currentCombatantId, 'c-hidden', 'GM sees the hidden current identity');
    assert.equal(dto.hasHiddenCurrentCombatant, false);
    assert.equal(dto.combatants[1].isCurrent, true);
    assert.equal(dto.canAdvanceTurn, true);
    assert.equal(dto.canRewindTurn, true);
    assert.ok(dto.combatants.every(row => row.canRollInitiative), 'GM can roll for every row');
    assert.equal(dto.combatants[2].defeated, true);
}

function runPlayerRedaction() {
    const dto = buildCombatTrackerDto(preparedFixture(), player, deps);

    assert.deepEqual(dto.combatants.map(r => r.id), ['c-player', 'c-npc'], 'hidden rows are pruned for players');
    assert.equal(dto.combatants[0].canRollInitiative, true, 'player can roll for their owned actor');
    assert.equal(dto.combatants[1].canRollInitiative, false, 'player cannot roll for the NPC');
    assert.ok(dto.combatants.every(row => row.actor === null), 'projection itself attaches no actor payloads');
}

function runHiddenCurrentCombatant() {
    const dto = buildCombatTrackerDto(preparedFixture(), player, deps);

    // The current combatant is hidden from this viewer: identity must not
    // leak, and no visible row may claim the highlight (CMB-01).
    assert.equal(dto.currentCombatantId, null);
    assert.equal(dto.hasHiddenCurrentCombatant, true);
    assert.ok(dto.combatants.every(row => !row.isCurrent), 'no visible row is marked current');
    assert.equal(dto.canAdvanceTurn, false, 'players cannot advance through a hidden current combatant');
}

function runVisibleCurrentCapabilities() {
    const prepared = preparedFixture({ turn: 0, currentCombatantId: 'c-player' });

    const playerDto = buildCombatTrackerDto(prepared, player, deps);
    assert.equal(playerDto.currentCombatantId, 'c-player');
    assert.equal(playerDto.hasHiddenCurrentCombatant, false);
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

    // A player with no combatant in the forming encounter receives no rows —
    // the encounter stays invisible to them until it starts.
    const bystander = { userId: 'p-2', role: FoundryUserRole.PLAYER };
    const bystanderDto = buildCombatTrackerDto(prepared, bystander, deps);
    assert.equal(bystanderDto.combatants.length, 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('combat-tracker-projection.test.ts passed');
}
