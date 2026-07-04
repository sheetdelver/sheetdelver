import { strict as assert } from 'node:assert';
import path from 'node:path';
import { ActorStore, actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { ActorRepository } from '@server/core/documents/primary/actors/ActorRepository';
import { initDataDir, resolveDataDir } from '@server/core/paths';
import {
    DOCUMENT_VISIBILITY,
    DocumentOwnershipLevel,
    FoundryUserRole,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import { createSystemRouteFoundryClient } from '@server/shared/utils/createRouteFoundryClient';
import { DocumentResolver } from '@server/services/documents';
import { systemService } from '@server/services/world';
import type { ActorDocument } from '@server/shared/types/actors';

export async function run() {
    initDataDir(resolveDataDir(['--data-dir', path.join(process.cwd(), 'temp', 'test-data')]));
    await runActorStoreOwnershipAndClone();
    await runActorStoreMutations();
    await runEmbeddedCreateIdempotency();
    await runActorRepositoryAppliesEffects();
    await runRouteClientReadsFromActorStore();
    await runRouteClientRoutesNestedActorItemEffectsThroughActorRepository();
    await runRouteClientActorWritesUseGenericTransportOnly();
    await runRouteClientUsesServiceOwnedAdapterForActorValidation();
    await runRouteClientBlocksActorReadsBeforeStoreReady();
    await runDocumentResolverActorUuidReadsFromActorStore();
}

async function runActorStoreOwnershipAndClone() {
    const store = new ActorStore();
    const player: DocumentAccessSubject = { userId: 'user-1', role: FoundryUserRole.PLAYER };
    const gm: DocumentAccessSubject = { userId: 'gm-1', role: FoundryUserRole.GAMEMASTER };

    const actors: ActorDocument[] = [
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

    // Broadcast-shaped embedded delete: id strings in result, no operation.ids
    // (ADR-0031 — Foundry-side deletions arrive like this).
    store.applyModifyDocument('Item', 'delete', ['item-1'], {
        parentUuid: 'Actor.actor-1',
    });
    assert.equal(store.get('actor-1')?.items?.length, 0, 'broadcast-shaped item delete applies');
}

// Regression: a Sheet-Delver-initiated write applies the same embedded create twice — once
// when the Repository mirrors the Foundry result, once when the broadcast lands (ADR-0012).
// The create push must be idempotent by `_id` or one added item shows up as two.
async function runEmbeddedCreateIdempotency() {
    const store = new ActorStore();
    await store.seed(async () => ([
        {
            _id: 'a1',
            name: 'Hero',
            items: [],
            effects: [],
            ownership: { default: DocumentOwnershipLevel.OWNER },
        },
    ] as unknown as ActorDocument[]));

    const item = { _id: 'item-x', name: 'Sword', type: 'weapon' };
    const op = { parentUuid: 'Actor.a1' };

    store.applyModifyDocument('Item', 'create', [item], op);  // mirror
    store.applyModifyDocument('Item', 'create', [item], op);  // broadcast (same _id)
    assert.equal(store.get('a1')?.items?.length, 1, 'embedded Item create is idempotent (mirror + broadcast → one)');
    assert.equal(store.get('a1')?.items?.[0]._id, 'item-x');

    // A genuinely different item still creates.
    store.applyModifyDocument('Item', 'create', [{ _id: 'item-y', name: 'Shield', type: 'shield' }], op);
    assert.equal(store.get('a1')?.items?.length, 2, 'distinct items still create');

    // Actor-level ActiveEffect create is idempotent too.
    const eff = { _id: 'eff-1', label: 'Cursed' };
    store.applyModifyDocument('ActiveEffect', 'create', [eff], op);
    store.applyModifyDocument('ActiveEffect', 'create', [eff], op);
    assert.equal(((store.get('a1') as { effects?: unknown[] }).effects ?? []).length, 1, 'embedded effect create is idempotent');
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
        url: 'http://foundry.test',
        userId: null,
        on: () => undefined,
        off: () => undefined,
        getSystem: async () => ({ id: 'generic' }),
        dispatchDocument: async () => ({}),
        dispatchDocumentSocket: async () => ({}),
    } as any);

    assert.equal((await client.getActors()).length, 1);
    assert.equal((await client.getActor('actor-cached'))?.name, 'Cached Actor');
    assert.equal(client.resolveUrl('/icons/foo.png'), 'http://foundry.test/icons/foo.png');
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
        url: 'http://foundry.test',
        userId: null,
        on: () => undefined,
        off: () => undefined,
        getSystem: async () => ({ id: 'generic' }),
        dispatchDocument: async (type: string, action: string, operation: unknown, parent?: { type: string; id: string }) => {
            dispatchCalls.push({ type, action, operation, parent });
            return {
                result: [{ _id: 'effect-route', name: 'Route Effect' }],
                operation,
            };
        },
        dispatchDocumentSocket: async () => ({}),
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

async function runRouteClientActorWritesUseGenericTransportOnly() {
    await actorStore.seed(async () => ([
        {
            _id: 'actor-write',
            name: 'Actor Before Write',
            items: [],
            ownership: { default: DocumentOwnershipLevel.OWNER },
        },
    ]));

    const dispatchCalls: Array<{ type: string; action: string; operation: unknown; parent?: { type: string; id: string } }> = [];
    const client = createSystemRouteFoundryClient({
        isConnected: true,
        url: 'http://foundry.test',
        userId: null,
        on: () => undefined,
        off: () => undefined,
        getSystem: async () => ({ id: 'generic' }),
        dispatchDocument: async (type: string, action: string, operation: unknown, parent?: { type: string; id: string }) => {
            dispatchCalls.push({ type, action, operation, parent });
            if (type === 'Actor' && action === 'create') return { result: [{ _id: 'actor-created', name: 'Created Actor' }], operation };
            if (type === 'Actor' && action === 'update') return { result: [{ _id: 'actor-write', name: 'Actor After Write' }], operation };
            if (type === 'Actor' && action === 'delete') return { result: [{ _id: 'actor-write' }], operation };
            if (type === 'Item' && action === 'create') return { result: [{ _id: 'item-write', name: 'Created Item' }], operation };
            if (type === 'Item' && action === 'update') return { result: [{ _id: 'item-write', name: 'Updated Item' }], operation };
            if (type === 'Item' && action === 'delete') return { result: [{ _id: 'item-write' }], operation };
            return { result: [], operation };
        },
        dispatchDocumentSocket: async () => ({}),
    } as any);

    const created = await client.createActor({ name: 'Created Actor' }) as any;
    assert.equal(created._id, 'actor-created');

    await client.updateActor('actor-write', { name: 'Actor After Write' });
    assert.equal(actorStore.get('actor-write')?.name, 'Actor After Write');

    const itemId = await client.createActorItem('actor-write', { name: 'Created Item' });
    assert.equal(itemId, 'item-write');

    await client.updateActorItem('actor-write', { _id: 'item-write', name: 'Updated Item' });
    await client.deleteActorItem('actor-write', 'item-write');
    await client.deleteActor('actor-write');

    assert.deepEqual(
        dispatchCalls.map(call => `${call.type}:${call.action}`),
        ['Actor:create', 'Actor:update', 'Item:create', 'Item:update', 'Item:delete', 'Actor:delete'],
    );

    actorStore.clear('route-client-actor-write-test');
}

async function runRouteClientUsesServiceOwnedAdapterForActorValidation() {
    await actorStore.seed(async () => ([
        {
            _id: 'actor-filter',
            name: 'Actor Before Filter',
            ownership: { default: DocumentOwnershipLevel.OWNER },
        },
    ]));

    const originalGetActiveAdapter = (systemService as any).getActiveAdapter;
    const dispatchCalls: Array<{ type: string; action: string; operation: unknown }> = [];

    try {
        (systemService as any).getActiveAdapter = () => ({
            validateUpdate: (path: string) => path === 'name',
        });

        const client = createSystemRouteFoundryClient({
            isConnected: true,
            url: 'http://foundry.test',
            userId: null,
            on: () => undefined,
            off: () => undefined,
            getSystem: async () => ({ id: 'generic' }),
            dispatchDocument: async (type: string, action: string, operation: unknown) => {
                dispatchCalls.push({ type, action, operation });
                return {
                    result: [{ _id: 'actor-filter', name: 'Allowed Name' }],
                    operation,
                };
            },
            dispatchDocumentSocket: async () => ({}),
        } as any);

        await client.updateActor('actor-filter', {
            name: 'Allowed Name',
            'system.attributes.hp.value': 12,
        });

        assert.equal(dispatchCalls.length, 1);
        assert.deepEqual((dispatchCalls[0].operation as any).updates, [
            { _id: 'actor-filter', name: 'Allowed Name' },
        ]);

        const noOp = await client.updateActor('actor-filter', {
            'system.attributes.hp.max': 20,
        }) as { success?: boolean; message?: string };

        assert.deepEqual(noOp, { success: true, message: 'No sanctioned updates' });
        assert.equal(dispatchCalls.length, 1);
    } finally {
        (systemService as any).getActiveAdapter = originalGetActiveAdapter;
        actorStore.clear('route-client-adapter-filter-test');
    }
}

async function runRouteClientBlocksActorReadsBeforeStoreReady() {
    actorStore.clear('not-ready-test');

    let socketFetches = 0;
    const client = createSystemRouteFoundryClient({
        isConnected: true,
        url: 'http://foundry.test',
        userId: null,
        on: () => undefined,
        off: () => undefined,
        getSystem: async () => ({ id: 'generic' }),
        dispatchDocument: async () => ({}),
        dispatchDocumentSocket: async () => ({}),
    } as any);

    await assert.rejects(() => client.getActors(), /Actor document cache is not ready/);
    await assert.rejects(() => client.getActor('actor-cached'), /Actor document cache is not ready/);
    await assert.rejects(() => client.getActorRaw('actor-cached'), /Actor document cache is not ready/);
    assert.equal(socketFetches, 0);
}

async function runDocumentResolverActorUuidReadsFromActorStore() {
    actorStore.clear('uuid-test');
    const resolver = new DocumentResolver();

    await assert.rejects(() => resolver.fetchByUuid('Actor.actor-cached'), /Actor document cache is not ready/);

    await actorStore.seed(async () => ([
        {
            _id: 'actor-cached',
            name: 'Cached Actor',
            ownership: { default: DocumentOwnershipLevel.OWNER },
        },
    ]));

    assert.equal(((await resolver.fetchByUuid('Actor.actor-cached')) as ActorDocument | null)?.name, 'Cached Actor');
    actorStore.clear('uuid-test');
}
