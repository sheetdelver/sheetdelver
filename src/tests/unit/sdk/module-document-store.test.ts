import { strict as assert } from 'node:assert';
import { createDocumentStore } from '@server/shared/utils/moduleDocumentServices';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { DocumentOwnershipLevel } from '@server/core/documents/primary/base/ownership';
import { SdkError, isSdkError } from '@shared/sdk';
import type { ActorDocument } from '@server/shared/types/actors';

/**
 * Exercises the route `DocumentStore` access enforcement (ADR-0027 decisions 9/10/25):
 *  - reads are subject-scoped and fail closed when the subject cannot resolve,
 *  - writes require OWNER-level (WRITEABLE) ownership on the target,
 *  - missing docs / insufficient ownership block (permission_denied),
 *  - `commit` verifies every op before dispatching any,
 *  - the `{ access }` override acts as a different subject,
 *  - the readiness gate surfaces `not_ready` on both reads and writes.
 *
 * `ensureReady` is injected (no-op / throwing) so the suite never depends on a live world.
 */

interface DispatchCall { type: string; action: string; operation: unknown; parent?: { type: string; id: string } }

function makeClient(
    userId: string | null,
    calls: DispatchCall[],
    fetchByUuid: (uuid: string) => Promise<Record<string, unknown> | null> = async () => null,
) {
    return {
        userId,
        isConnected: true,
        dispatchDocument: async (type: string, action: string, operation: unknown, parent?: { type: string; id: string }) => {
            calls.push({ type, action, operation, parent });
            return { result: [{ _id: 'dispatched', type, action }] };
        },
        fetchByUuid,
    } as never;
}

async function rejectsWithCode(fn: () => Promise<unknown>, code: string) {
    await assert.rejects(fn, (err: unknown) => isSdkError(err) && err.code === code);
}

// Override context — only `userId` is trusted by the store (role is re-derived from
// userStore), but the full ModuleAccessContext shape is required by the type.
const asOwner = { access: { userId: 'owner-user', role: 0, isGM: false, moduleId: 'test' } };

export async function run() {
    await actorStore.seed(async () => ([
        {
            _id: 'actor-owned',
            name: 'Owned Actor',
            ownership: { 'owner-user': DocumentOwnershipLevel.OWNER, default: DocumentOwnershipLevel.NONE },
            items: [{ _id: 'item-hidden', name: 'Hidden Dagger', type: 'loot' }],
        },
        {
            _id: 'actor-observed',
            name: 'Observed Actor',
            ownership: { 'player-user': DocumentOwnershipLevel.OBSERVER, 'owner-user': DocumentOwnershipLevel.OWNER },
        },
    ] as ActorDocument[]));

    const noop = async () => {};

    // --- owner: reads + writes allowed ---
    const ownerCalls: DispatchCall[] = [];
    const ownerStore = createDocumentStore(makeClient('owner-user', ownerCalls), noop);

    assert.equal((await ownerStore.get('Actor', 'actor-owned'))?.name, 'Owned Actor');
    await ownerStore.patch('Actor', 'actor-owned', { name: 'Renamed' });
    assert.equal(ownerCalls.length, 1);
    assert.equal(ownerCalls[0].action, 'update');

    await ownerStore.delete('Actor', 'actor-owned', asOwner);
    assert.equal(ownerCalls[1].action, 'delete');

    // --- embedded item CRUD: parent-ownership gated, dispatched with the parent ---
    ownerCalls.length = 0;
    await ownerStore.items.create({ type: 'Actor', id: 'actor-owned' }, { name: 'Torch', type: 'gear' });
    assert.equal(ownerCalls[0].type, 'Item');
    assert.equal(ownerCalls[0].action, 'create');
    assert.deepEqual(ownerCalls[0].parent, { type: 'Actor', id: 'actor-owned' });
    await ownerStore.items.delete({ type: 'Actor', id: 'actor-owned' }, 'item-1');
    assert.equal(ownerCalls[1].action, 'delete');
    assert.deepEqual(ownerCalls[1].parent, { type: 'Actor', id: 'actor-owned' });

    // --- owner: write to a missing doc is blocked (ambiguous ownership) ---
    ownerCalls.length = 0;
    await rejectsWithCode(() => ownerStore.patch('Actor', 'does-not-exist', { name: 'x' }), 'permission_denied');
    assert.equal(ownerCalls.length, 0, 'no dispatch on denied write');

    // --- player: can read what they observe, cannot read hidden, cannot write ---
    const playerCalls: DispatchCall[] = [];
    const playerStore = createDocumentStore(makeClient('player-user', playerCalls), noop);

    assert.equal((await playerStore.get('Actor', 'actor-observed'))?.name, 'Observed Actor');
    assert.equal(await playerStore.get('Actor', 'actor-owned'), null, 'player cannot see owner-only actor');
    await rejectsWithCode(() => playerStore.patch('Actor', 'actor-observed', { name: 'x' }), 'permission_denied');
    assert.equal(playerCalls.length, 0, 'observer write never dispatched');

    // --- fetchByUuid is access-scoped for world docs and root-gated for embedded docs ---
    const rawUuidFetch = async (uuid: string) => {
        if (uuid === 'Actor.actor-owned') return { _id: 'actor-owned', name: 'Raw Hidden Actor' };
        if (uuid === 'Actor.actor-observed') return { _id: 'actor-observed', name: 'Raw Observed Actor' };
        if (uuid === 'Actor.actor-owned.Item.item-hidden') return { _id: 'item-hidden', name: 'Raw Hidden Dagger' };
        return null;
    };
    const uuidOwnerStore = createDocumentStore(makeClient('owner-user', [], rawUuidFetch), noop);
    const uuidPlayerStore = createDocumentStore(makeClient('player-user', [], rawUuidFetch), noop);
    assert.equal((await uuidOwnerStore.fetchByUuid('Actor.actor-owned'))?.name, 'Owned Actor');
    assert.equal((await uuidOwnerStore.fetchByUuid('Actor.actor-owned.Item.item-hidden'))?.name, 'Raw Hidden Dagger');
    assert.equal(await uuidPlayerStore.fetchByUuid('Actor.actor-owned'), null, 'hidden world UUID returns null');
    assert.equal(await uuidPlayerStore.fetchByUuid('Actor.actor-owned.Item.item-hidden'), null, 'hidden root blocks embedded UUID');
    assert.equal((await uuidPlayerStore.fetchByUuid('Actor.actor-observed'))?.name, 'Observed Actor');

    // --- { access } override: player acts as the owner ---
    await playerStore.patch('Actor', 'actor-observed', { name: 'ByOwner' }, asOwner);
    assert.equal(playerCalls.length, 1, 'override write dispatched');

    // --- subject that cannot resolve fails closed ---
    const anonCalls: DispatchCall[] = [];
    const anonStore = createDocumentStore(makeClient(null, anonCalls), noop);
    await rejectsWithCode(() => anonStore.patch('Actor', 'actor-observed', { name: 'x' }), 'permission_denied');
    await rejectsWithCode(() => anonStore.get('Actor', 'actor-observed'), 'permission_denied');
    await rejectsWithCode(() => anonStore.fetchByUuid('Actor.actor-observed'), 'permission_denied');

    // --- commit verifies EVERY op before dispatching ANY ---
    const commitCalls: DispatchCall[] = [];
    const commitStore = createDocumentStore(makeClient('owner-user', commitCalls), noop);
    await rejectsWithCode(
        () => commitStore.commit('Actor', [
            { _id: 'actor-owned', name: 'ok' },     // owner-writable
            { _id: 'actor-observed', name: 'ok' },  // owner-writable
            { _id: 'missing-doc', name: 'denied' }, // blocks the whole batch
        ]),
        'permission_denied',
    );
    assert.equal(commitCalls.length, 0, 'commit dispatched nothing when one op is denied');

    // --- a fully-authorized commit dispatches each op ---
    const okCommitCalls: DispatchCall[] = [];
    const okCommitStore = createDocumentStore(makeClient('owner-user', okCommitCalls), noop);
    await okCommitStore.commit('Actor', [
        { _id: 'actor-owned', name: 'a' },
        { _id: 'actor-observed', name: 'b' },
    ]);
    assert.equal(okCommitCalls.length, 2);

    // --- readiness gate surfaces not_ready on reads AND writes ---
    const notReady = async () => { throw new SdkError('not_ready', 'world not ready'); };
    const gatedStore = createDocumentStore(makeClient('owner-user', []), notReady);
    await rejectsWithCode(() => gatedStore.get('Actor', 'actor-owned'), 'not_ready');
    await rejectsWithCode(() => gatedStore.patch('Actor', 'actor-owned', { name: 'x' }), 'not_ready');

    actorStore.clear('module-document-store-test');

    console.log('  - module DocumentStore enforcement: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('module-document-store.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
