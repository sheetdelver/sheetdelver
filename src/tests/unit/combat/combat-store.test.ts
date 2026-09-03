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
import type { CombatDocument } from '@server/shared/types/documents';
import type { ActorDocument } from '@server/shared/types/actors';

const player: DocumentAccessSubject = { userId: 'p-1', role: FoundryUserRole.PLAYER };
const otherPlayer: DocumentAccessSubject = { userId: 'p-2', role: FoundryUserRole.PLAYER };
const gm: DocumentAccessSubject = { userId: 'gm-1', role: FoundryUserRole.GAMEMASTER };

async function seedActorsFor(actors: ActorDocument[]): Promise<ActorStore> {
    const store = new ActorStore();
    await store.seed(async () => actors);
    return store;
}

export async function run() {
    await runOwnershipFromActorStore();
    await runHiddenCombatantsExcluded();
    await runFailClosedWithoutActorBinding();
    await runEmbeddedCombatantRouting();
    await runEmbeddedCombatantGroupRouting();
    await runFoundryShapedDeleteBroadcast();
    await runDirectParentUpdateVisibilityDiff();
    await runActorChangeBridgeEmitsCombatChanged();
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
    const combats: CombatDocument[] = [
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
    ] as CombatDocument[]);

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
    ] as CombatDocument[]);

    assert.equal(store.canReadDocument('orphan', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    // GM short-circuit still works without binding.
    assert.equal(store.canReadDocument('orphan', gm, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
}

async function runEmbeddedCombatantRouting() {
    const actor = await seedActorsFor([
        { _id: 'actor-a', ownership: { 'p-1': DocumentOwnershipLevel.OBSERVER } },
        { _id: 'actor-b', ownership: { 'p-1': DocumentOwnershipLevel.OBSERVER } },
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
    ] as CombatDocument[]);

    const events: DocumentChangedEvent[] = [];
    const invalidations: DocumentListInvalidatedEvent[] = [];
    store.on('documentChanged', (e) => events.push(e as DocumentChangedEvent));
    store.on('documentListInvalidated', (e) => invalidations.push(e as DocumentListInvalidatedEvent));

    // Create combatant via embedded routing.
    store.applyModifyDocument('Combatant', 'create', [
        { _id: 'c-new', actorId: 'actor-b', initiative: 5 },
    ], { parentUuid: 'Combat.combat-emb' });
    assert.equal(store.get('combat-emb')?.combatants?.length, 2);
    assert.equal(events.find((e) => e.id === 'combat-emb')?.action, 'update');
    assert.equal(invalidations.length, 1, 'new readable actor source invalidates combat list visibility');
    assert.equal(invalidations[0].reason, 'combatant-visibility-changed');
    assert.equal(invalidations[0].documentId, 'combat-emb');

    // Update combatant in place.
    store.applyModifyDocument('Combatant', 'update', [
        { _id: 'c-existing', initiative: 20 },
    ], { parentUuid: 'Combat.combat-emb' });
    const c = store.get('combat-emb')?.combatants?.find((x) => x._id === 'c-existing');
    assert.equal(c?.initiative, 20);
    assert.equal(invalidations.length, 1, 'initiative-only updates do not invalidate combat list visibility');

    // Idempotent update.
    const before = events.length;
    store.applyModifyDocument('Combatant', 'update', [
        { _id: 'c-existing', initiative: 20 },
    ], { parentUuid: 'Combat.combat-emb' });
    assert.equal(events.length, before, 'no-op update emits nothing');
    assert.equal(invalidations.length, 1, 'no-op update emits no list invalidation');

    // Hide a readable combatant — the visible combatant source set changes.
    store.applyModifyDocument('Combatant', 'update', [
        { _id: 'c-existing', hidden: true },
    ], { parentUuid: 'Combat.combat-emb' });
    assert.equal(store.get('combat-emb')?.combatants?.find((x) => x._id === 'c-existing')?.hidden, true);
    assert.equal(invalidations.length, 2, 'hidden toggle invalidates combat list visibility');

    // Delete combatant.
    store.applyModifyDocument('Combatant', 'delete', null, {
        parentUuid: 'Combat.combat-emb',
        ids: ['c-new'],
    });
    assert.equal(store.get('combat-emb')?.combatants?.length, 1);
    assert.equal(invalidations.length, 3, 'deleting last visible actor source invalidates combat list visibility');

    // Unknown embedded type silently dropped.
    store.applyModifyDocument('NotACombatChild', 'create', [{ _id: 'x' }], {
        parentUuid: 'Combat.combat-emb',
    });
    assert.equal(store.get('combat-emb')?.combatants?.length, 1);
}

async function runEmbeddedCombatantGroupRouting() {
    const actor = await seedActorsFor([
        { _id: 'actor-a', ownership: { 'p-1': DocumentOwnershipLevel.OBSERVER } },
    ]);
    const store = new CombatStore();
    store.bindActorVisibilityBridge(actor);
    await store.seed(async () => [
        {
            _id: 'combat-groups',
            combatants: [{ _id: 'c1', actorId: 'actor-a' }],
            groups: [],
        },
    ] as CombatDocument[]);

    const events: DocumentChangedEvent[] = [];
    const invalidations: DocumentListInvalidatedEvent[] = [];
    store.on('documentChanged', (e) => events.push(e as DocumentChangedEvent));
    store.on('documentListInvalidated', (e) => invalidations.push(e as DocumentListInvalidatedEvent));

    // Create group via embedded routing.
    store.applyModifyDocument('CombatantGroup', 'create', [
        { _id: 'grp-1', name: 'Goblins', initiative: null },
    ], { parentUuid: 'Combat.combat-groups' });
    assert.equal(store.get('combat-groups')?.groups?.length, 1);
    assert.equal(events.filter((e) => e.id === 'combat-groups' && e.action === 'update').length, 1);

    // Idempotent create: mirror + broadcast double-apply must not duplicate.
    store.applyModifyDocument('CombatantGroup', 'create', [
        { _id: 'grp-1', name: 'Goblins', initiative: null },
    ], { parentUuid: 'Combat.combat-groups' });
    assert.equal(store.get('combat-groups')?.groups?.length, 1, 'group create is idempotent by id');

    // Update group in place.
    store.applyModifyDocument('CombatantGroup', 'update', [
        { _id: 'grp-1', initiative: 12 },
    ], { parentUuid: 'Combat.combat-groups' });
    assert.equal(store.get('combat-groups')?.groups?.find((g) => g._id === 'grp-1')?.initiative, 12);

    // No-op update emits nothing.
    const before = events.length;
    store.applyModifyDocument('CombatantGroup', 'update', [
        { _id: 'grp-1', initiative: 12 },
    ], { parentUuid: 'Combat.combat-groups' });
    assert.equal(events.length, before, 'no-op group update emits nothing');

    // Delete group.
    store.applyModifyDocument('CombatantGroup', 'delete', null, {
        parentUuid: 'Combat.combat-groups',
        ids: ['grp-1'],
    });
    assert.equal(store.get('combat-groups')?.groups?.length, 0);

    // Group changes never alter the combatant-derived visibility source.
    assert.equal(invalidations.length, 0, 'group mutations do not invalidate combat list visibility');
}

async function runFoundryShapedDeleteBroadcast() {
    // Foundry delete broadcasts to non-initiating clients carry the deleted
    // ids in `result` as plain strings; `operation.ids` is not reliable on
    // this path (Foundry's own client re-records it from `result`). A combat
    // ended in the Foundry UI arrives exactly like this — it must not
    // silently no-op and leave the cache (and every HUD) stale.
    const actor = await seedActorsFor([
        { _id: 'actor-a', ownership: { 'p-1': DocumentOwnershipLevel.OBSERVER } },
    ]);
    const store = new CombatStore();
    store.bindActorVisibilityBridge(actor);
    await store.seed(async () => [
        {
            _id: 'combat-ended',
            active: true,
            round: 3,
            combatants: [
                { _id: 'c1', actorId: 'actor-a', initiative: 10 },
                { _id: 'c2', actorId: 'actor-a', initiative: 5 },
            ],
        },
    ] as CombatDocument[]);

    const events: DocumentChangedEvent[] = [];
    const invalidations: DocumentListInvalidatedEvent[] = [];
    store.on('documentChanged', (e) => events.push(e as DocumentChangedEvent));
    store.on('documentListInvalidated', (e) => invalidations.push(e as DocumentListInvalidatedEvent));

    // Embedded combatant delete, broadcast shape: string ids in result, no
    // operation.ids.
    store.applyModifyDocument('Combatant', 'delete', ['c2'], {
        parentUuid: 'Combat.combat-ended',
    });
    assert.equal(store.get('combat-ended')?.combatants?.length, 1,
        'broadcast-shaped combatant delete applies from result ids');

    // Parent combat delete, broadcast shape ("End Combat" in the Foundry UI):
    // result holds the deleted id strings, operation has no ids.
    store.applyModifyDocument('Combat', 'delete', ['combat-ended'], {
        modifiedTime: Date.now(),
    });
    assert.equal(store.get('combat-ended'), null, 'broadcast-shaped combat delete removes the document');
    assert.ok(
        events.some((e) => e.id === 'combat-ended' && e.action === 'delete'),
        'combat delete emits documentChanged so clients refetch',
    );
    assert.ok(
        invalidations.some((e) => e.reason === 'delete' && e.documentId === 'combat-ended'),
        'combat delete emits a list invalidation',
    );

    // Repeated broadcast (mirror + broadcast double-apply) stays a no-op.
    const changedCount = events.length;
    store.applyModifyDocument('Combat', 'delete', ['combat-ended'], {});
    assert.equal(events.length, changedCount, 'second delete apply emits nothing');
}

async function runDirectParentUpdateVisibilityDiff() {
    const actor = await seedActorsFor([
        { _id: 'actor-readable', ownership: { 'p-1': DocumentOwnershipLevel.OBSERVER } },
    ]);
    const store = new CombatStore();
    store.bindActorVisibilityBridge(actor);
    await store.seed(async () => [
        {
            _id: 'combat-direct',
            round: 1,
            turn: 0,
            combatants: [{ _id: 'c1', actorId: 'actor-readable' }],
        },
    ] as CombatDocument[]);

    const invalidations: DocumentListInvalidatedEvent[] = [];
    store.on('documentListInvalidated', (e) => invalidations.push(e as DocumentListInvalidatedEvent));

    // Round/turn-only direct update: document changes, visibility source doesn't.
    store.applyModifyDocument('Combat', 'update', [
        { _id: 'combat-direct', round: 2, turn: 0 },
    ]);
    assert.equal(store.get('combat-direct')?.round, 2);
    assert.equal(invalidations.length, 0, 'progression-only parent update does not invalidate the list');

    // Direct parent update replaces `combatants` with a hidden-only roster —
    // the player's last visibility source disappears and former viewers must
    // be told (Foundry performs direct parent combatant updates like this).
    store.applyModifyDocument('Combat', 'update', [
        { _id: 'combat-direct', combatants: [{ _id: 'c1', actorId: 'actor-readable', hidden: true }] },
    ]);
    assert.equal(store.canReadDocument('combat-direct', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false,
        'hidden-only roster removes non-GM visibility');
    const visibilityInvalidations = invalidations.filter((e) => e.reason === 'combat-visibility-source-changed');
    assert.equal(visibilityInvalidations.length, 1, 'visibility-source change on direct parent update invalidates the list');
    assert.equal(visibilityInvalidations[0].documentId, 'combat-direct');

    // Restoring visibility also invalidates, so the returning viewer refetches.
    store.applyModifyDocument('Combat', 'update', [
        { _id: 'combat-direct', combatants: [{ _id: 'c1', actorId: 'actor-readable', hidden: false }] },
    ]);
    assert.equal(store.canReadDocument('combat-direct', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(
        invalidations.filter((e) => e.reason === 'combat-visibility-source-changed').length,
        2,
        'visibility restoration invalidates the list again',
    );
}

async function runActorChangeBridgeEmitsCombatChanged() {
    const actor = await seedActorsFor([
        { _id: 'actor-enemy', name: 'Old Name', ownership: { default: DocumentOwnershipLevel.NONE } },
        { _id: 'actor-unrelated', name: 'Bystander', ownership: { default: DocumentOwnershipLevel.NONE } },
    ]);
    const store = new CombatStore();
    store.bindActorVisibilityBridge(actor);
    await store.seed(async () => [
        {
            _id: 'combat-with-enemy',
            combatants: [{ _id: 'c1', actorId: 'actor-enemy' }],
        },
        {
            _id: 'combat-without-enemy',
            combatants: [{ _id: 'c2', actorId: 'actor-someone-else' }],
        },
    ] as CombatDocument[]);

    const events: DocumentChangedEvent[] = [];
    store.on('documentChanged', (e) => events.push(e as DocumentChangedEvent));

    // Ordinary actor update (display data feeding tracker rows). The player
    // can't read this actor directly, but the combat projection renders its
    // name/img — the combat must announce a change regardless.
    actor.applyModifyDocument('Actor', 'update', [
        { _id: 'actor-enemy', name: 'New Name' },
    ]);

    const combatUpdates = events.filter((e) => e.action === 'update');
    assert.equal(combatUpdates.length, 1, 'actor update refreshes exactly the combats containing it');
    assert.equal(combatUpdates[0].id, 'combat-with-enemy');

    // Actors not present in any combat propagate nothing.
    actor.applyModifyDocument('Actor', 'update', [
        { _id: 'actor-unrelated', name: 'Renamed Bystander' },
    ]);
    assert.equal(events.filter((e) => e.action === 'update').length, 1, 'unrelated actor updates do not propagate');
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
    ] as CombatDocument[]);

    const invalidations: DocumentListInvalidatedEvent[] = [];
    store.on('documentListInvalidated', (e) => invalidations.push(e as DocumentListInvalidatedEvent));

    // Force an actor list invalidation on the shared actor — only the combat
    // containing it should fire combatListInvalidated.
    (actor as any).emitListInvalidated('ownership-test', {
        documentId: 'actor-shared',
        audience: { kind: 'users', userIds: ['p-1', 'p-2'] },
    });

    const propagated = invalidations.filter((e) => e.reason === 'actor-visibility-changed');
    assert.equal(propagated.length, 1, 'one combat invalidation fired');
    assert.equal(propagated[0].documentId, 'combat-with-shared');
    assert.deepEqual(propagated[0].audience, { kind: 'users', userIds: ['p-1', 'p-2'] });

    // No combat contains the unrelated actor — nothing fires.
    const beforeUnrelated = invalidations.length;
    (actor as any).emitListInvalidated('ownership-test', {
        documentId: 'actor-completely-unknown',
        audience: { kind: 'users', userIds: ['p-1'] },
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
