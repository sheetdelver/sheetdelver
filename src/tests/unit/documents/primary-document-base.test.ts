import { strict as assert } from 'node:assert';
import {
    PrimaryDocumentStore,
    appendCreatedById,
    type ModifyDocumentAction,
    type DocumentChangedEvent,
    type DocumentListInvalidatedEvent,
    type PrimaryDocumentType,
} from '@server/core/documents/primary/base/PrimaryDocumentStore';
import {
    DocumentOwnershipLevel,
    FoundryUserRole,
    getEffectiveOwnership,
    type DocumentAccessSubject,
    type DocumentOwnershipMap,
    type ResolvedDocumentOwnershipLevel,
} from '@server/core/documents/primary/base/ownership';

/**
 * Mock document type and Store used for generic base-contract verification.
 * Shape mirrors the standard Foundry primary doc (id + ownership map).
 */
interface MockDoc {
    _id?: string;
    id?: string;
    name?: string;
    ownership?: DocumentOwnershipMap;
    system?: Record<string, unknown>;
    [key: string]: unknown;
}

class MockStore extends PrimaryDocumentStore<MockDoc> {
    public readonly documentType: PrimaryDocumentType = 'Cards'; // borrow an unused type for the mock

    protected resolveOwnership(
        doc: MockDoc,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        return getEffectiveOwnership(doc.ownership, subject);
    }
}

export async function run() {
    await runSeedAndCloning();
    await runOwnershipFilteredReads();
    await runUpsertEmitsOnlyOnChange();
    await runPatchDottedKeys();
    await runDeleteIdempotency();
    await runNoEmissionDuringSeeding();
    await runListInvalidationOnOwnershipCrossing();
    await runGenericPrimaryDocumentChangedEvent();
    await runApplyModifyDocumentRoutes();
    runAppendCreatedByIdIdempotency();
    console.log('  - PrimaryDocumentStore<T> base: all checks passed');
}

// The shared embedded-create helper every store routes through (items/effects/combatants/
// cards/sounds/pages/results). Guards the idempotency that prevents a mirror + broadcast
// double-apply from duplicating one added child (ADR-0012).
function runAppendCreatedByIdIdempotency() {
    const existing: MockDoc[] = [{ _id: 'a', name: 'A' }];

    // Re-applying the same created child is a no-op (deduped by _id).
    const once = appendCreatedById(existing, [{ _id: 'b', name: 'B' }]);
    const twice = appendCreatedById(once, [{ _id: 'b', name: 'B' }]);
    assert.deepEqual(twice.map(d => d._id), ['a', 'b'], 'same _id is not appended twice');

    // Distinct ids still append; cloned (not the same reference).
    const more = appendCreatedById(twice, [{ _id: 'c', name: 'C' }]);
    assert.deepEqual(more.map(d => d._id), ['a', 'b', 'c']);

    // Children with no id have no key to dedupe on — appended as-is.
    const noId = appendCreatedById<MockDoc>([], [{ name: 'x' }, { name: 'y' }]);
    assert.equal(noId.length, 2, 'id-less children are appended');

    // Undefined existing is treated as empty.
    assert.deepEqual(appendCreatedById(undefined, [{ _id: 'z' }]).map(d => d._id), ['z']);
}

async function runSeedAndCloning() {
    const store = new MockStore();
    const docs: MockDoc[] = [
        { _id: 'a', name: 'Alpha', ownership: { default: DocumentOwnershipLevel.OBSERVER } },
        { _id: 'b', name: 'Beta', ownership: { default: DocumentOwnershipLevel.OWNER } },
    ];
    await store.seed(async () => docs);

    assert.equal(store.isReady(), true);
    assert.equal(store.list().length, 2);

    // Clone-on-read: mutating the returned doc must not affect the cache.
    const a = store.get('a')!;
    a.name = 'Mutated';
    assert.equal(store.get('a')?.name, 'Alpha');
}

async function runOwnershipFilteredReads() {
    const store = new MockStore();
    const gm: DocumentAccessSubject = { userId: 'gm', role: FoundryUserRole.GAMEMASTER };
    const player: DocumentAccessSubject = { userId: 'p1', role: FoundryUserRole.PLAYER };

    await store.seed(async () => [
        { _id: 'public', ownership: { default: DocumentOwnershipLevel.OBSERVER } },
        { _id: 'private', ownership: { default: DocumentOwnershipLevel.NONE } },
        { _id: 'mine', ownership: { default: DocumentOwnershipLevel.NONE, p1: DocumentOwnershipLevel.OWNER } },
    ]);

    // Player sees public + mine
    const playerList = store.list({ subject: player }).map(d => d._id).sort();
    assert.deepEqual(playerList, ['mine', 'public']);

    // GM sees everything regardless of map
    const gmList = store.list({ subject: gm }).map(d => d._id).sort();
    assert.deepEqual(gmList, ['mine', 'private', 'public']);

    // get returns null on denied access
    assert.equal(store.get('private', { subject: player }), null);
    assert.equal(store.get('mine', { subject: player })?._id, 'mine');

    // canReadDocument matches the boolean form
    assert.equal(store.canReadDocument('private', player), false);
    assert.equal(store.canReadDocument('mine', player), true);
    assert.equal(store.canReadDocument('private', gm), true);
    assert.equal(store.canReadDocument('missing', player), false);
}

async function runUpsertEmitsOnlyOnChange() {
    const store = new MockStore();
    await store.seed(async () => []);

    const events: DocumentChangedEvent[] = [];
    store.on('documentChanged', (e: DocumentChangedEvent) => events.push(e));

    store.upsert({ _id: 'x', name: 'X' });
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'create');

    // Same doc again → no event
    store.upsert({ _id: 'x', name: 'X' });
    assert.equal(events.length, 1);

    // Mutation → event
    store.upsert({ _id: 'x', name: 'X-mod' });
    assert.equal(events.length, 2);
    assert.equal(events[1].action, 'update');
}

async function runPatchDottedKeys() {
    const store = new MockStore();
    await store.seed(async () => [
        { _id: 'a', system: { attributes: { hp: { value: 10, max: 10 } } } },
    ]);

    const events: DocumentChangedEvent[] = [];
    store.on('documentChanged', e => events.push(e as DocumentChangedEvent));

    store.patch('a', { 'system.attributes.hp.value': 5 });
    const doc = store.get('a')!;
    assert.equal((doc.system as any).attributes.hp.value, 5);
    assert.equal((doc.system as any).attributes.hp.max, 10); // siblings preserved
    assert.equal(events.length, 1);

    // Idempotent: same patch twice → one event total
    store.patch('a', { 'system.attributes.hp.value': 5 });
    assert.equal(events.length, 1);

    // Missing doc → markStale, no event
    store.patch('missing', { name: 'ghost' });
    assert.equal(events.length, 1);
}

async function runDeleteIdempotency() {
    const store = new MockStore();
    await store.seed(async () => [{ _id: 'a' }, { _id: 'b' }]);

    const events: DocumentChangedEvent[] = [];
    store.on('documentChanged', e => events.push(e as DocumentChangedEvent));

    store.delete('a');
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'delete');

    // Delete the same id again → no event
    store.delete('a');
    assert.equal(events.length, 1);
}

async function runNoEmissionDuringSeeding() {
    const store = new MockStore();
    const events: DocumentChangedEvent[] = [];
    store.on('documentChanged', e => events.push(e as DocumentChangedEvent));

    await store.seed(async () => [
        { _id: 'a' }, { _id: 'b' }, { _id: 'c' },
    ]);

    // Seeding 3 docs must emit nothing — events fire only after isReady() === true.
    assert.equal(events.length, 0);

    // After seed, mutations DO emit.
    store.upsert({ _id: 'd' });
    assert.equal(events.length, 1);
}

async function runListInvalidationOnOwnershipCrossing() {
    const store = new MockStore();
    await store.seed(async () => [
        { _id: 'a', ownership: { default: DocumentOwnershipLevel.NONE, p1: DocumentOwnershipLevel.OWNER } },
    ]);

    const invalidations: DocumentListInvalidatedEvent[] = [];
    store.on('documentListInvalidated', e => invalidations.push(e as DocumentListInvalidatedEvent));

    // Add a new user with OWNER access — list visibility transitions for p2.
    store.applyModifyDocument('Cards', 'update', [
        { _id: 'a', ownership: { default: DocumentOwnershipLevel.NONE, p1: DocumentOwnershipLevel.OWNER, p2: DocumentOwnershipLevel.OBSERVER } },
    ]);

    const crossing = invalidations.find(e => e.reason === 'ownership-user-changed');
    assert.ok(crossing, 'expected ownership-user-changed invalidation');
    assert.deepEqual(crossing?.targetUserIds, ['p2']);

    // Drop p2 below visibility threshold — another listInvalidated.
    invalidations.length = 0;
    store.applyModifyDocument('Cards', 'update', [
        { _id: 'a', ownership: { default: DocumentOwnershipLevel.NONE, p1: DocumentOwnershipLevel.OWNER, p2: DocumentOwnershipLevel.NONE } },
    ]);
    const downward = invalidations.find(e => e.reason === 'ownership-user-changed');
    assert.deepEqual(downward?.targetUserIds, ['p2']);

    // Default flips to visible-by-default → broadcast-wide (no targetUserIds).
    invalidations.length = 0;
    store.applyModifyDocument('Cards', 'update', [
        { _id: 'a', ownership: { default: DocumentOwnershipLevel.OBSERVER, p1: DocumentOwnershipLevel.OWNER, p2: DocumentOwnershipLevel.NONE } },
    ]);
    const defaultFlip = invalidations.find(e => e.reason === 'ownership-default-changed');
    assert.ok(defaultFlip, 'expected ownership-default-changed invalidation');
    assert.equal(defaultFlip?.targetUserIds, undefined);
}

async function runGenericPrimaryDocumentChangedEvent() {
    const store = new MockStore();
    await store.seed(async () => []);

    const typed: DocumentChangedEvent[] = [];
    const generic: DocumentChangedEvent[] = [];
    store.on('documentChanged', e => typed.push(e as DocumentChangedEvent));
    store.on('primaryDocumentChanged', e => generic.push(e as DocumentChangedEvent));

    store.upsert({ _id: 'a' });

    // Both per-type and cross-cutting events fire from a single state change.
    assert.equal(typed.length, 1);
    assert.equal(generic.length, 1);
    assert.equal(generic[0].type, 'Cards');
    assert.equal(generic[0].id, 'a');
    assert.equal(generic[0].action, 'create');
}

async function runApplyModifyDocumentRoutes() {
    // Self-type routes through applySelfChange (default behavior verified above).
    // Embedded-type routes through the subclass hook. Build a Store that overrides
    // applyEmbeddedChange to confirm dispatch.
    let embeddedCalls = 0;
    class EmbeddedStore extends MockStore {
        protected applyEmbeddedChange(_type: string, _action: ModifyDocumentAction): void {
            embeddedCalls += 1;
        }
    }
    const store = new EmbeddedStore();
    await store.seed(async () => []);

    // Same-type event — does NOT invoke embedded handler.
    store.applyModifyDocument('Cards', 'create', [{ _id: 'a' }]);
    assert.equal(embeddedCalls, 0);

    // Different-type event — invokes embedded handler.
    store.applyModifyDocument('Card', 'create', [{ _id: 'inner' }], { parentUuid: 'Cards.a' });
    assert.equal(embeddedCalls, 1);
}

