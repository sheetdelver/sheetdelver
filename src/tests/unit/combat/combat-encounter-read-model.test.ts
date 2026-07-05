import { strict as assert } from 'node:assert';
import {
    CombatEncounterReadModel,
    type EncounterChangedEvent,
} from '@server/core/documents/encounters/CombatEncounterReadModel';
import { CombatStore } from '@server/core/documents/primary/combats/CombatStore';
import { ActorStore } from '@server/core/documents/primary/actors/ActorStore';
import { DocumentOwnershipLevel } from '@server/core/documents/primary/base/ownership';
import type { CombatDocument } from '@server/shared/types/documents';
import type { ActorDocument } from '@server/shared/types/actors';

/**
 * ADR-0028 Phase 3: the event-maintained encounter read model. Prepared
 * ordering follows Foundry `_sortCombatants` (initiative desc, null last,
 * id-ascending ties); current identity resolves the raw `turn` index against
 * the full pre-redaction order; Combat document events drive rebuild/remove.
 */

interface Harness {
    actorStore: ActorStore;
    combatStore: CombatStore;
    readModel: CombatEncounterReadModel;
    events: EncounterChangedEvent[];
}

async function createHarness(combats: CombatDocument[], actors: ActorDocument[] = []): Promise<Harness> {
    const actorStore = new ActorStore();
    await actorStore.seed(async () => actors);
    const combatStore = new CombatStore();
    combatStore.bindActorVisibilityBridge(actorStore);
    await combatStore.seed(async () => combats);

    const readModel = new CombatEncounterReadModel();
    readModel.bind(combatStore, actorStore);
    readModel.rebuildAll();

    const events: EncounterChangedEvent[] = [];
    readModel.on('encounterChanged', (e) => events.push(e as EncounterChangedEvent));
    return { actorStore, combatStore, readModel, events };
}

export async function run() {
    await runBuildAllAndOrdering();
    await runCurrentCombatantResolution();
    await runRebuildOnCombatantEvents();
    await runGroupEvents();
    await runDeleteRemovesEncounter();
    await runActorFallbackIdentityAndBridge();
    await runDefeatedStatusDerivation();
    console.log('  - CombatEncounterReadModel: all checks passed');
}

async function runBuildAllAndOrdering() {
    const { readModel, events } = await createHarness([
        {
            _id: 'combat-1',
            active: true,
            round: 2,
            turn: 1,
            combatants: [
                { _id: 'c-slow', actorId: 'a1', initiative: 5 },
                { _id: 'c-unrolled', actorId: 'a1', initiative: null },
                { _id: 'c-fast', actorId: 'a1', initiative: 20 },
                // Tie with c-fast — id-ascending tiebreak puts c-also-fast first.
                { _id: 'c-also-fast', actorId: 'a1', initiative: 20 },
            ],
        },
    ]);

    assert.equal(events.length, 0, 'rebuildAll (seed path) emits nothing');
    assert.equal(readModel.isReady(), true);
    assert.equal(readModel.list().length, 1);

    const encounter = readModel.get('combat-1')!;
    assert.deepEqual(
        encounter.rows.map((r) => r.id),
        ['c-also-fast', 'c-fast', 'c-slow', 'c-unrolled'],
        'Foundry ordering: initiative desc, null last, id-ascending ties',
    );
    assert.equal(encounter.active, true);
    assert.equal(encounter.started, true, 'round > 0 means started');
    assert.equal(encounter.round, 2);
    assert.equal(encounter.currentCombatantId, 'c-fast', 'turn 1 resolves against prepared order');

    // Clone-on-read: mutating the returned encounter must not affect the model.
    encounter.rows.pop();
    assert.equal(readModel.get('combat-1')?.rows.length, 4);
}

async function runCurrentCombatantResolution() {
    const { readModel } = await createHarness([
        {
            _id: 'combat-prestart',
            active: true,
            round: 0,
            turn: null,
            combatants: [{ _id: 'c1', actorId: 'a1', initiative: null }],
        },
        {
            _id: 'combat-out-of-range',
            active: true,
            round: 1,
            turn: 9,
            combatants: [{ _id: 'c1', actorId: 'a1', initiative: 10 }],
        },
    ]);

    const prestart = readModel.get('combat-prestart')!;
    assert.equal(prestart.started, false);
    assert.equal(prestart.turn, null);
    assert.equal(prestart.currentCombatantId, null, 'null turn resolves to no current combatant');

    const outOfRange = readModel.get('combat-out-of-range')!;
    assert.equal(outOfRange.currentCombatantId, null, 'out-of-range turn resolves to no current combatant');
}

async function runRebuildOnCombatantEvents() {
    const { combatStore, readModel, events } = await createHarness([
        {
            _id: 'combat-live',
            active: true,
            round: 1,
            turn: 0,
            combatants: [
                { _id: 'c-a', actorId: 'a1', initiative: 15 },
                { _id: 'c-b', actorId: 'a1', initiative: 10 },
            ],
        },
    ]);

    assert.equal(readModel.get('combat-live')?.currentCombatantId, 'c-a');

    // Initiative update reorders: c-b overtakes. The current identity follows
    // the raw turn index into the new prepared order — index-preserving
    // adjustments on reorder are the command side's job (Phase 5), not ours.
    combatStore.applyModifyDocument('Combatant', 'update', [
        { _id: 'c-b', initiative: 30 },
    ], { parentUuid: 'Combat.combat-live' });

    const reordered = readModel.get('combat-live')!;
    assert.deepEqual(reordered.rows.map((r) => r.id), ['c-b', 'c-a']);
    assert.equal(reordered.currentCombatantId, 'c-b', 'turn index resolves against the rebuilt order');
    assert.ok(events.some((e) => e.combatId === 'combat-live' && e.action === 'rebuild'),
        'combatant event triggers an encounterChanged rebuild');

    // Combatant create lands in the prepared order.
    combatStore.applyModifyDocument('Combatant', 'create', [
        { _id: 'c-c', actorId: 'a1', initiative: 20 },
    ], { parentUuid: 'Combat.combat-live' });
    assert.deepEqual(readModel.get('combat-live')?.rows.map((r) => r.id), ['c-b', 'c-c', 'c-a']);

    // Combatant delete (broadcast shape) leaves the prepared order current.
    combatStore.applyModifyDocument('Combatant', 'delete', ['c-c'], {
        parentUuid: 'Combat.combat-live',
    });
    assert.deepEqual(readModel.get('combat-live')?.rows.map((r) => r.id), ['c-b', 'c-a']);

    // Direct parent progression update recomputes current identity.
    combatStore.applyModifyDocument('Combat', 'update', [
        { _id: 'combat-live', turn: 1 },
    ]);
    assert.equal(readModel.get('combat-live')?.currentCombatantId, 'c-a');
}

async function runGroupEvents() {
    const { combatStore, readModel } = await createHarness([
        {
            _id: 'combat-grouped',
            active: true,
            round: 1,
            turn: 0,
            combatants: [{ _id: 'c1', actorId: 'a1', initiative: 10, group: 'grp-1' }],
            groups: [],
        },
    ]);

    combatStore.applyModifyDocument('CombatantGroup', 'create', [
        { _id: 'grp-1', name: 'Goblins', initiative: null },
    ], { parentUuid: 'Combat.combat-grouped' });

    let encounter = readModel.get('combat-grouped')!;
    assert.deepEqual(encounter.groups, [{ id: 'grp-1', name: 'Goblins', img: null, initiative: null }]);
    assert.equal(encounter.rows[0].groupId, 'grp-1', 'rows carry their group linkage');

    combatStore.applyModifyDocument('CombatantGroup', 'update', [
        { _id: 'grp-1', initiative: 12 },
    ], { parentUuid: 'Combat.combat-grouped' });
    encounter = readModel.get('combat-grouped')!;
    assert.equal(encounter.groups[0].initiative, 12);

    combatStore.applyModifyDocument('CombatantGroup', 'delete', ['grp-1'], {
        parentUuid: 'Combat.combat-grouped',
    });
    assert.deepEqual(readModel.get('combat-grouped')?.groups, []);
}

async function runDeleteRemovesEncounter() {
    const { combatStore, readModel, events } = await createHarness([
        {
            _id: 'combat-doomed',
            active: true,
            round: 1,
            turn: 0,
            combatants: [{ _id: 'c1', actorId: 'a1', initiative: 10 }],
        },
    ]);

    // Broadcast-shaped delete (ADR-0031): string ids in result.
    combatStore.applyModifyDocument('Combat', 'delete', ['combat-doomed'], {});
    assert.equal(readModel.get('combat-doomed'), null);
    assert.equal(readModel.list().length, 0);
    assert.ok(events.some((e) => e.combatId === 'combat-doomed' && e.action === 'delete'),
        'encounter removal emits a delete event');

    // Repeat delete stays silent (idempotent, mirrors store behavior).
    const count = events.length;
    readModel.remove('combat-doomed');
    assert.equal(events.length, count);
}

async function runActorFallbackIdentityAndBridge() {
    const { actorStore, readModel } = await createHarness(
        [
            {
                _id: 'combat-identity',
                active: true,
                round: 1,
                turn: 0,
                combatants: [
                    // No combatant display fields — falls back to the actor.
                    { _id: 'c-fallback', actorId: 'actor-enemy', initiative: 10 },
                    // Combatant display identity wins over the actor's.
                    { _id: 'c-named', actorId: 'actor-enemy', name: 'Disguised', img: 'mask.png', initiative: 5 },
                ],
            },
        ],
        [
            {
                _id: 'actor-enemy',
                name: 'Goblin',
                img: 'goblin.png',
                ownership: { default: DocumentOwnershipLevel.NONE },
            } as ActorDocument,
        ],
    );

    let encounter = readModel.get('combat-identity')!;
    const fallback = encounter.rows.find((r) => r.id === 'c-fallback')!;
    assert.equal(fallback.name, 'Goblin', 'actor name fallback');
    assert.equal(fallback.img, 'goblin.png', 'actor img fallback');
    const named = encounter.rows.find((r) => r.id === 'c-named')!;
    assert.equal(named.name, 'Disguised', 'combatant display name wins');
    assert.equal(named.img, 'mask.png', 'combatant display img wins');

    // Ordinary actor update flows through CombatStore's actor bridge into a
    // rebuild — the prepared identity must pick up the rename.
    actorStore.applyModifyDocument('Actor', 'update', [
        { _id: 'actor-enemy', name: 'Hobgoblin' },
    ]);
    encounter = readModel.get('combat-identity')!;
    assert.equal(encounter.rows.find((r) => r.id === 'c-fallback')?.name, 'Hobgoblin',
        'actor rename rebuilds fallback identity via the store bridge');
    assert.equal(encounter.rows.find((r) => r.id === 'c-named')?.name, 'Disguised',
        'explicit combatant identity is unaffected by actor changes');
}

async function runDefeatedStatusDerivation() {
    const { actorStore, readModel } = await createHarness(
        [
            {
                _id: 'combat-death',
                active: true,
                round: 1,
                turn: 0,
                combatants: [
                    { _id: 'c-flagged', actorId: 'actor-npc', initiative: 15, defeated: true },
                    { _id: 'c-dying-pc', actorId: 'actor-dying', initiative: 10 },
                    { _id: 'c-dead-status', actorId: 'actor-dead', initiative: 5 },
                ],
            },
        ],
        [
            { _id: 'actor-npc', name: 'Goblin' },
            // Dying PC: unconscious (death saves) — must NOT read as defeated.
            {
                _id: 'actor-dying',
                name: 'Downed Hero',
                effects: [{ _id: 'fx-unc', statuses: ['unconscious'] }],
            },
            // Dead status is Foundry's defeated special status.
            {
                _id: 'actor-dead',
                name: 'Slain Bandit',
                effects: [{ _id: 'fx-dead', statuses: ['dead'] }],
            },
        ] as ActorDocument[],
    );

    const encounter = readModel.get('combat-death')!;
    const byId = (id: string) => encounter.rows.find((r) => r.id === id)!;
    assert.equal(byId('c-flagged').defeated, true, 'combatant flag marks defeated');
    assert.equal(byId('c-dying-pc').defeated, false, 'unconscious (death saves) is not defeated');
    assert.equal(byId('c-dead-status').defeated, true, 'actor dead status derives defeated');

    // Live transition: the dying PC fails their saves — the dead status lands
    // as an embedded ActiveEffect on the actor, and the actor bridge rebuilds
    // the encounter without any combatant write.
    actorStore.applyModifyDocument('ActiveEffect', 'update', [
        { _id: 'fx-unc', statuses: ['dead'] },
    ], { parentUuid: 'Actor.actor-dying' });

    assert.equal(
        readModel.get('combat-death')!.rows.find((r) => r.id === 'c-dying-pc')?.defeated,
        true,
        'dead status applied to the actor flips the prepared row via the store bridge',
    );
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('combat-encounter-read-model.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
