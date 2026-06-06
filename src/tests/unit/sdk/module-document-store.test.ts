import { strict as assert } from 'node:assert';
import { createDocumentStore, createChatRuntime } from '@server/shared/utils/moduleDocumentServices';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { chatMessageStore } from '@server/core/documents/primary/chat-messages/ChatMessageStore';
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

    // --- chat runtime: author defaulting + rollMode visibility (ADR-0027) ---
    // Foundry denies a non-GM creating a ChatMessage authored by anyone else, so the
    // runtime defaults `author` to the acting user; rollMode sets whisper/blind, and
    // explicit message fields override (manual targeting wins).
    {
        const sent: Record<string, unknown>[] = [];
        const chatClient = {
            userId: 'player-user',
            createChatMessage: async (data: Record<string, unknown>) => { sent.push(data); return { result: [data] }; },
            useItem: async () => true,
        } as never;
        const chat = createChatRuntime(chatClient, noop);

        // 1. author defaults to the acting user; public roll adds no whisper/blind.
        await chat.send({ content: 'hi' }, { rollMode: 'publicroll' });
        assert.equal(sent[0].author, 'player-user', 'chat.send must default author to the acting user');
        assert.equal(sent[0].whisper, undefined, 'publicroll must not whisper');
        assert.equal(sent[0].blind, undefined, 'publicroll must not be blind');

        // 2. self roll whispers to self only; author still defaulted.
        await chat.send({ content: 'self' }, { rollMode: 'selfroll' });
        assert.deepEqual(sent[1].whisper, ['player-user'], 'selfroll whispers to self');
        assert.equal(sent[1].author, 'player-user');

        // 3. blind roll sets blind; author still the acting user.
        await chat.send({ content: 'blind' }, { rollMode: 'blindroll' });
        assert.equal(sent[2].blind, true, 'blindroll must be blind');
        assert.equal(sent[2].author, 'player-user');

        // 4. card() defaults author too.
        await chat.card({ title: 'Card', content: 'body' });
        assert.equal(sent[3].author, 'player-user', 'chat.card must default author to the acting user');

        // 5. explicit author + explicit whisper override the defaults (manual targeting wins).
        await chat.send({ content: 'gm-said', author: 'gm-user', whisper: ['someone'] }, { rollMode: 'selfroll' });
        assert.equal(sent[4].author, 'gm-user', 'explicit author preserved');
        assert.deepEqual(sent[4].whisper, ['someone'], 'explicit whisper overrides rollMode');
    }

    // --- document store: author-bearing creates (ChatMessage/Macro) default author ---
    // A module may also post chat via the generic store, not just chat.send — that path
    // must attach the author too, or Foundry denies a non-GM create.
    {
        await chatMessageStore.seed(async () => []);
        const chatDocCalls: DispatchCall[] = [];
        const chatDocStore = createDocumentStore(makeClient('player-user', chatDocCalls), noop);

        await chatDocStore.create('ChatMessage', { content: 'via store' });
        const created = chatDocCalls.find(call => call.type === 'ChatMessage' && call.action === 'create');
        const createdData = (created?.operation as { data: Record<string, unknown>[] }).data[0];
        assert.equal(createdData.author, 'player-user', 'documents.create(ChatMessage) must default author to the acting user');

        await chatDocStore.create('ChatMessage', { content: 'gm', author: 'gm-user' });
        const explicit = chatDocCalls.filter(call => call.type === 'ChatMessage' && call.action === 'create')[1];
        const explicitData = (explicit?.operation as { data: Record<string, unknown>[] }).data[0];
        assert.equal(explicitData.author, 'gm-user', 'explicit author preserved on store create');

        chatMessageStore.clear('module-document-store-test');
    }

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
