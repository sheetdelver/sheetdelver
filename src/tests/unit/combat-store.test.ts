import { strict as assert } from 'node:assert';
import { CombatStore, combatStore } from '@server/core/documents/primary/combats/CombatStore';
import { CombatRepository } from '@server/core/documents/primary/combats/CombatRepository';
import { ActorStore, actorStore } from '@server/core/documents/primary/actors/ActorStore';
import {
    DOCUMENT_VISIBILITY,
    DocumentOwnershipLevel,
    FoundryUserRole,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import type {
    DocumentChangedEvent,
    DocumentListInvalidatedEvent,
} from '@server/core/documents/primary/base/PrimaryDocumentStore';
import type { RawCombat } from '@server/shared/types/documents';
import type { RawActor } from '@server/shared/types/actors';

const player: DocumentAccessSubject = { userId: 'p-1', role: FoundryUserRole.PLAYER };
const otherPlayer: DocumentAccessSubject = { userId: 'p-2', role: FoundryUserRole.PLAYER };
const gm: DocumentAccessSubject = { userId: 'gm-1', role: FoundryUserRole.GAMEMASTER };

async function seedActorsFor(actors: RawActor[]): Promise<ActorStore> {
    const store = new ActorStore();
    await store.seed(async () => actors);
    return store;
}

export async function run() {
    await runOwnershipFromActorStore();
    await runHiddenCombatantsExcluded();
    await runFailClosedWithoutActorBinding();
    await runEmbeddedCombatantRouting();
    await runActorVisibilityBridgePropagates();
    await runRepositoryMirrorsWrites();
    console.log('  - CombatStore: all checks passed');
}

async function runOwnershipFromActorStore() {
    const actor = await seedActorsFor([
        { _id: 'actor-readable', ownership: { 'p-1': DocumentOwnershipLevel.OBSERVER } },
        { _id: 'actor-hidden', ownership: { default: DocumentOwnershipLevel.NONE } },
    ]);

    const store = new CombatStore();
    store.bindActorVisibilityBridge(actor);
    const combats: RawCombat[] = [
        {
            _id: 'combat-visible',
            combatants: [
                { _id: 'c1', actorId: 'actor-readable' },
                { _id: 'c2', actorId: 'actor-hidden' },
            ],
        },
        {
            _id: 'combat-hidden',
            combatants: [
                { _id: 'c3', actorId: 'actor-hidden' },
            ],
        },
        {
            _id: 'combat-missing-actor',
            combatants: [
                { _id: 'c4', actorId: 'actor-does-not-exist' },
            ],
        },
    ];
    await store.seed(async () => combats);

    assert.equal(store.canReadDocument('combat-visible', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(store.canReadDocument('combat-hidden', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(store.canReadDocument('combat-missing-actor', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false,
        'missing actor fails closed for non-GMs');

    // GM sees everything as OWNER.
    assert.equal(store.canReadDocument('combat-visible', gm, DOCUMENT_VISIBILITY.WRITEABLE), true);
    assert.equal(store.canReadDocument('combat-hidden', gm, DOCUMENT_VISIBILITY.WRITEABLE), true);
    assert.equal(store.canReadDocument('combat-missing-actor', gm, DOCUMENT_VISIBILITY.WRITEABLE), true);

    // Subject-filtered list returns only the combats the player can read.
    const playerList = store.list({ subject: player });
    assert.deepEqual(playerList.map((c) => c._id).sort(), ['combat-visible']);
    const gmList = store.list({ subject: gm });
    assert.equal(gmList.length, 3);
}

async function runHiddenCombatantsExcluded() {
    const actor = await seedActorsFor([
        { _id: 'actor-readable', ownership: { 'p-1': DocumentOwnershipLevel.OBSERVER } },
    ]);
    const store = new CombatStore();
    store.bindActorVisibilityBridge(actor);

    await store.seed(async () => [
        {
            _id: 'combat-with-hidden',
            combatants: [
                { _id: 'c1', actorId: 'actor-readable', hidden: true },
            ],
        },
    ] as RawCombat[]);

    // The only readable-actor combatant is hidden — non-GM cannot see the combat.
    assert.equal(store.canReadDocument('combat-with-hidden', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false,
        'hidden combatants do not grant visibility to non-GMs');
    assert.equal(store.canReadDocument('combat-with-hidden', gm, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
}

async function runFailClosedWithoutActorBinding() {
    // A CombatStore that has not been bound to ActorStore should fail closed
    // for non-GMs (no way to resolve actor visibility).
    const store = new CombatStore();
    await store.seed(async () => [
        {
            _id: 'orphan',
            combatants: [{ _id: 'c1', actorId: 'whatever' }],
        },
    ] as RawCombat[]);

    assert.equal(store.canReadDocument('orphan', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    // GM short-circuit still works without binding.
    assert.equal(store.canReadDocument('orphan', gm, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
}

async function runEmbeddedCombatantRouting() {
    const actor = await seedActorsFor([
        { _id: 'actor-a', ownership: { 'p-1': DocumentOwnershipLevel.OBSERVER } },
    ]);
    const store = new CombatStore();
    store.bindActorVisibilityBridge(actor);
    await store.seed(async () => [
        {
            _id: 'combat-emb',
            combatants: [
                { _id: 'c-existing', actorId: 'actor-a', initiative: 10 },
            ],
        },
    ] as RawCombat[]);

    const events: DocumentChangedEvent[] = [];
    store.on('documentChanged', (e) => events.push(e as DocumentChangedEvent));

    // Create combatant via embedded routing.
    store.applyModifyDocument('Combatant', 'create', [
        { _id: 'c-new', actorId: 'actor-a', initiative: 5 },
    ], { parentUuid: 'Combat.combat-emb' });
    assert.equal(store.get('combat-emb')?.combatants?.length, 2);
    assert.equal(events.find((e) => e.id === 'combat-emb')?.action, 'update');

    // Update combatant in place.
    store.applyModifyDocument('Combatant', 'update', [
        { _id: 'c-existing', initiative: 20 },
    ], { parentUuid: 'Combat.combat-emb' });
    const c = store.get('combat-emb')?.combatants?.find((x) => x._id === 'c-existing');
    assert.equal(c?.initiative, 20);

    // Idempotent update.
    const before = events.length;
    store.applyModifyDocument('Combatant', 'update', [
        { _id: 'c-existing', initiative: 20 },
    ], { parentUuid: 'Combat.combat-emb' });
    assert.equal(events.length, before, 'no-op update emits nothing');

    // Delete combatant.
    store.applyModifyDocument('Combatant', 'delete', null, {
        parentUuid: 'Combat.combat-emb',
        ids: ['c-new'],
    });
    assert.equal(store.get('combat-emb')?.combatants?.length, 1);

    // Unknown embedded type silently dropped.
    store.applyModifyDocument('NotACombatChild', 'create', [{ _id: 'x' }], {
        parentUuid: 'Combat.combat-emb',
    });
    assert.equal(store.get('combat-emb')?.combatants?.length, 1);
}

async function runActorVisibilityBridgePropagates() {
    const actor = await seedActorsFor([
        { _id: 'actor-shared', ownership: { default: DocumentOwnershipLevel.OBSERVER } },
        { _id: 'actor-unrelated', ownership: { default: DocumentOwnershipLevel.OBSERVER } },
    ]);
    const store = new CombatStore();
    store.bindActorVisibilityBridge(actor);
    await store.seed(async () => [
        {
            _id: 'combat-with-shared',
            combatants: [{ _id: 'c1', actorId: 'actor-shared' }],
        },
        {
            _id: 'combat-without-shared',
            combatants: [{ _id: 'c2', actorId: 'actor-unrelated' }],
        },
    ] as RawCombat[]);

    const invalidations: DocumentListInvalidatedEvent[] = [];
    store.on('documentListInvalidated', (e) => invalidations.push(e as DocumentListInvalidatedEvent));

    // Force an actor list invalidation on the shared actor — only the combat
    // containing it should fire combatListInvalidated.
    (actor as any).emitListInvalidated('ownership-test', {
        documentId: 'actor-shared',
        targetUserIds: ['p-1', 'p-2'],
    });

    const propagated = invalidations.filter((e) => e.reason === 'actor-visibility-changed');
    assert.equal(propagated.length, 1, 'one combat invalidation fired');
    assert.equal(propagated[0].documentId, 'combat-with-shared');
    assert.deepEqual(propagated[0].targetUserIds, ['p-1', 'p-2']);

    // No combat contains the unrelated actor — nothing fires.
    const beforeUnrelated = invalidations.length;
    (actor as any).emitListInvalidated('ownership-test', {
        documentId: 'actor-completely-unknown',
        targetUserIds: ['p-1'],
    });
    assert.equal(invalidations.length, beforeUnrelated, 'unknown actors do not propagate');
}

async function runRepositoryMirrorsWrites() {
    const store = combatStore;
    store.bindActorVisibilityBridge(actorStore);
    await store.seed(async () => []);

    const dispatches: Array<{ type: string; action: string; operation: any; parent?: any }> = [];
    const repository = new CombatRepository({
        dispatchDocument: async (type, action, operation, parent) => {
            dispatches.push({ type, action, operation, parent });
            if (type === 'Combat' && action === 'create') {
                return {
                    result: [{ _id: 'created-combat', round: 0, turn: -1, combatants: [] }],
                    operation,
                };
            }
            if (type === 'Combatant' && action === 'create') {
                return {
                    result: [{ _id: 'created-combatant', actorId: 'actor-a', initiative: null }],
                    operation,
                };
            }
            return { result: [], operation };
        },
    });

    try {
        await repository.create({ active: true });
        assert.equal(dispatches[0].type, 'Combat');
        assert.equal(dispatches[0].action, 'create');
        assert.equal(store.get('created-combat')?._id, 'created-combat');

        await repository.createCombatant('created-combat', { actorId: 'actor-a' });
        const cDispatch = dispatches.find((d) => d.type === 'Combatant' && d.action === 'create');
        assert.ok(cDispatch);
        assert.deepEqual(cDispatch!.parent, { type: 'Combat', id: 'created-combat' });
        assert.equal(store.get('created-combat')?.combatants?.length, 1);
        assert.equal(store.get('created-combat')?.combatants?.[0]?._id, 'created-combatant');

        await repository.updateCombatant('created-combat', 'created-combatant', { initiative: 17 });
        const uDispatch = dispatches.find((d) => d.type === 'Combatant' && d.action === 'update');
        assert.ok(uDispatch);
        assert.deepEqual(uDispatch!.parent, { type: 'Combat', id: 'created-combat' });
    } finally {
        store.clear('combat-repository-test');
        actorStore.clear('combat-repository-test');
    }
    // Silence unused references during test isolation.
    void otherPlayer;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('combat-store.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
