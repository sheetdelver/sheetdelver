import { strict as assert } from 'node:assert';
import path from 'node:path';
import { ActorStore, actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { ActorRepository } from '@server/core/documents/primary/actors/ActorRepository';
import { CoreSocket } from '@server/core/foundry/sockets/CoreSocket';
import { initDataDir, resolveDataDir } from '@server/core/paths';
import {
    DOCUMENT_VISIBILITY,
    DocumentOwnershipLevel,
    FoundryUserRole,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import { createSystemRouteFoundryClient } from '@server/shared/utils/createRouteFoundryClient';
import type { RawActor } from '@server/shared/types/actors';

export async function run() {
    initDataDir(resolveDataDir(['--data-dir', path.join(process.cwd(), 'temp', 'test-data')]));
    await runActorStoreOwnershipAndClone();
    await runActorStoreMutations();
    await runActorRepositoryAppliesEffects();
    await runRouteClientReadsFromActorStore();
    await runRouteClientRoutesNestedActorItemEffectsThroughActorRepository();
    await runRouteClientBlocksActorReadsBeforeStoreReady();
    await runCoreSocketActorUuidReadsFromActorStore();
}

async function runActorStoreOwnershipAndClone() {
    const store = new ActorStore();
    const player: DocumentAccessSubject = { userId: 'user-1', role: FoundryUserRole.PLAYER };
    const gm: DocumentAccessSubject = { userId: 'gm-1', role: FoundryUserRole.GAMEMASTER };

    const actors: RawActor[] = [
        {
            _id: 'limited',
            name: 'Limited Actor',
            ownership: { default: DocumentOwnershipLevel.LIMITED },
        },
        {
            _id: 'observed',
            name: 'Observed Actor',
            ownership: { 'user-1': DocumentOwnershipLevel.OBSERVER },
        },
        {
            _id: 'hidden',
            name: 'Hidden Actor',
            ownership: { default: DocumentOwnershipLevel.NONE },
        },
    ];

    await store.seed(async () => actors);

    assert.equal(store.isReady(), true);
    assert.deepEqual(
        store.listActors({ subject: player, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE }).map(actor => actor._id),
        ['limited', 'observed'],
    );
    assert.deepEqual(
        store.listActors({ subject: player, minOwnership: DOCUMENT_VISIBILITY.DETAIL_VISIBLE }).map(actor => actor._id),
        ['observed'],
    );
    assert.equal(store.getActor('hidden', { subject: gm })?._id, 'hidden');

    const clone = store.get('observed')!;
    clone.name = 'Mutated Outside Store';
    assert.equal(store.get('observed')?.name, 'Observed Actor');
}

async function runActorStoreMutations() {
    const store = new ActorStore();
    const events: string[] = [];
    store.onActorStoreEvent(event => {
        if (event.type === 'actorChanged') events.push(`${event.actorId}:${event.action}`);
    });

    await store.seed(async () => ([
        {
            _id: 'actor-1',
            name: 'Actor One',
            system: { attributes: { hp: { value: 7 } } },
            items: [{ _id: 'item-1', name: 'Sword', system: { quantity: 1 } }],
            ownership: { default: DocumentOwnershipLevel.OWNER },
        },
    ]));

    store.applyModifyDocument('Actor', 'update', [{ _id: 'actor-1', 'system.attributes.hp.value': 5 }]);
    assert.equal((store.get('actor-1')?.system as any).attributes.hp.value, 5);

    store.applyModifyDocument('Item', 'update', [{ _id: 'item-1', system: { quantity: 2 } }], {
        parentUuid: 'Actor.actor-1',
    });
    assert.equal(store.get('actor-1')?.items?.[0].system?.quantity, 2);

    store.applyModifyDocument('ActiveEffect', 'create', [{ _id: 'effect-1', label: 'Blessed' }], {
        parentUuid: 'Actor.actor-1.Item.item-1',
    });
    assert.equal((store.get('actor-1')?.items?.[0].effects as any[])?.[0]._id, 'effect-1');

    assert.deepEqual(events, ['actor-1:update', 'actor-1:update', 'actor-1:update']);

    // Applying the same visible state twice should not create duplicate realtime work.
    store.applyModifyDocument('Actor', 'update', [{ _id: 'actor-1', 'system.attributes.hp.value': 5 }]);
    assert.deepEqual(events, ['actor-1:update', 'actor-1:update', 'actor-1:update']);
}

async function runActorRepositoryAppliesEffects() {
    const store = actorStore;
    await store.seed(async () => ([
        {
            _id: 'actor-repo',
            name: 'Repo Actor',
            items: [{ _id: 'item-repo', name: 'Repo Item', effects: [] }],
            ownership: { default: DocumentOwnershipLevel.OWNER },
        },
    ]));

    const repository = new ActorRepository({
        dispatchDocument: async (_type, _action, operation) => ({
            result: [{ _id: 'effect-repo', name: 'Repository Effect' }],
            operation,
        }),
    });

    // Repository responses are applied immediately so the requester sees its write before broadcast.
    const effect = await repository.createItemEffect('actor-repo', 'item-repo', { name: 'Repository Effect' });
    assert.equal(effect._id, 'effect-repo');
    assert.equal((store.get('actor-repo')?.items?.[0].effects as any[])?.[0]._id, 'effect-repo');

    store.clear('repository-test');
}

async function runRouteClientReadsFromActorStore() {
    await actorStore.seed(async () => ([
        {
            _id: 'actor-cached',
            name: 'Cached Actor',
            ownership: { default: DocumentOwnershipLevel.OWNER },
        },
    ]));

    let socketFetches = 0;
    const client = createSystemRouteFoundryClient({
        isConnected: true,
        userId: null,
        on: () => undefined,
        off: () => undefined,
        getSystem: async () => ({ id: 'generic' }),
        getActors: async () => {
            socketFetches += 1;
            return [];
        },
        getActor: async () => {
            socketFetches += 1;
            return null;
        },
        getActorRaw: async () => null,
        createActor: async () => null,
        deleteActor: async () => undefined,
        updateActor: async () => undefined,
        dispatchDocument: async () => ({}),
        roll: async () => ({}),
        useItem: async () => ({}),
        createActorItem: async () => ({}),
        updateActorItem: async () => undefined,
        deleteActorItem: async () => undefined,
        resolveUrl: (url?: string) => url || '',
        getChatLog: async () => [],
        dispatchDocumentSocket: async () => ({}),
        fetchByUuid: async () => null,
        getAllCompendiumIndices: async () => [],
        getSharedContent: () => null,
    } as any);

    assert.equal((await client.getActors()).length, 1);
    assert.equal((await client.getActor('actor-cached'))?.name, 'Cached Actor');
    assert.equal(socketFetches, 0);

    actorStore.clear('unit-test');
}

async function runRouteClientRoutesNestedActorItemEffectsThroughActorRepository() {
    await actorStore.seed(async () => ([
        {
            _id: 'actor-route',
            name: 'Route Actor',
            items: [{ _id: 'item-route', name: 'Route Item', effects: [] }],
            ownership: { default: DocumentOwnershipLevel.OWNER },
        },
    ]));

    const dispatchCalls: Array<{ type: string; action: string; operation: unknown; parent?: { type: string; id: string } }> = [];
    const client = createSystemRouteFoundryClient({
        isConnected: true,
        userId: null,
        on: () => undefined,
        off: () => undefined,
        getSystem: async () => ({ id: 'generic' }),
        getActors: async () => [],
        getActor: async () => null,
        getActorRaw: async () => null,
        createActor: async () => null,
        deleteActor: async () => undefined,
        updateActor: async () => undefined,
        dispatchDocument: async (type: string, action: string, operation: unknown, parent?: { type: string; id: string }) => {
            dispatchCalls.push({ type, action, operation, parent });
            return {
                result: [{ _id: 'effect-route', name: 'Route Effect' }],
                operation,
            };
        },
        roll: async () => ({}),
        useItem: async () => ({}),
        createActorItem: async () => ({}),
        updateActorItem: async () => undefined,
        deleteActorItem: async () => undefined,
        resolveUrl: (url?: string) => url || '',
        getChatLog: async () => [],
        dispatchDocumentSocket: async () => ({}),
        fetchByUuid: async () => null,
        getAllCompendiumIndices: async () => [],
        getSharedContent: () => null,
    } as any);

    await client.dispatchDocument(
        'ActiveEffect',
        'create',
        { data: [{ name: 'Route Effect' }] },
        { type: 'Actor.actor-route.Item', id: 'item-route' },
    );

    assert.equal(dispatchCalls.length, 1);
    assert.deepEqual(dispatchCalls[0].parent, { type: 'Actor.actor-route.Item', id: 'item-route' });
    assert.equal((actorStore.get('actor-route')?.items?.[0].effects as any[])?.[0]._id, 'effect-route');

    actorStore.clear('route-client-nested-effect-test');
}

async function runRouteClientBlocksActorReadsBeforeStoreReady() {
    actorStore.clear('not-ready-test');

    let socketFetches = 0;
    const client = createSystemRouteFoundryClient({
        isConnected: true,
        userId: null,
        on: () => undefined,
        off: () => undefined,
        getSystem: async () => ({ id: 'generic' }),
        getActors: async () => {
            socketFetches += 1;
            return [];
        },
        getActor: async () => {
            socketFetches += 1;
            return null;
        },
        getActorRaw: async () => {
            socketFetches += 1;
            return null;
        },
        createActor: async () => null,
        deleteActor: async () => undefined,
        updateActor: async () => undefined,
        dispatchDocument: async () => ({}),
        roll: async () => ({}),
        useItem: async () => ({}),
        createActorItem: async () => ({}),
        updateActorItem: async () => undefined,
        deleteActorItem: async () => undefined,
        resolveUrl: (url?: string) => url || '',
        getChatLog: async () => [],
        dispatchDocumentSocket: async () => ({}),
        fetchByUuid: async () => null,
        getAllCompendiumIndices: async () => [],
        getSharedContent: () => null,
    } as any);

    await assert.rejects(() => client.getActors(), /Actor document cache is not ready/);
    await assert.rejects(() => client.getActor('actor-cached'), /Actor document cache is not ready/);
    await assert.rejects(() => client.getActorRaw('actor-cached'), /Actor document cache is not ready/);
    assert.equal(socketFetches, 0);
}

async function runCoreSocketActorUuidReadsFromActorStore() {
    actorStore.clear('uuid-test');
    const socket = new CoreSocket({ url: 'http://foundry.invalid' } as any);

    await assert.rejects(() => socket.fetchByUuid('Actor.actor-cached'), /Actor document cache is not ready/);

    await actorStore.seed(async () => ([
        {
            _id: 'actor-cached',
            name: 'Cached Actor',
            ownership: { default: DocumentOwnershipLevel.OWNER },
        },
    ]));

    assert.equal((await socket.fetchByUuid('Actor.actor-cached'))?.name, 'Cached Actor');
    actorStore.clear('uuid-test');
}
