import { strict as assert } from 'node:assert';
import { ItemStore, itemStore } from '@server/core/documents/primary/items/ItemStore';
import { ItemRepository } from '@server/core/documents/primary/items/ItemRepository';
import {
    DOCUMENT_VISIBILITY,
    DocumentOwnershipLevel,
    FoundryUserRole,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import type {
    DocumentChangedEvent,
} from '@server/core/documents/primary/base/PrimaryDocumentStore';
import type { RawItem } from '@server/shared/types/actors';

const player: DocumentAccessSubject = { userId: 'p-1', role: FoundryUserRole.PLAYER };
const otherPlayer: DocumentAccessSubject = { userId: 'p-2', role: FoundryUserRole.PLAYER };
const gm: DocumentAccessSubject = { userId: 'gm-1', role: FoundryUserRole.GAMEMASTER };

export async function run() {
    await runSeedAndCloneOnRead();
    await runOwnershipPolicy();
    await runListByFolderIds();
    await runEmbeddedActiveEffectRouting();
    await runRepositoryMirrorsWrites();
    console.log('  - ItemStore: all checks passed');
}

async function runSeedAndCloneOnRead() {
    const store = new ItemStore();
    await store.seed(async () => [
        {
            _id: 'i-1',
            name: 'Sword',
            type: 'Basic',
            folder: 'folder-1',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
            effects: [],
        },
    ]);

    assert.equal(store.isReady(), true);
    assert.equal(store.list().length, 1);

    // Defensive clone on read.
    const clone = store.get('i-1')!;
    clone.name = 'Mutated';
    assert.equal(store.get('i-1')?.name, 'Sword');
}

async function runOwnershipPolicy() {
    const store = new ItemStore();
    const items: RawItem[] = [
        {
            _id: 'i-public',
            name: 'Public',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
        },
        {
            _id: 'i-private',
            name: 'Private',
            ownership: { default: DocumentOwnershipLevel.NONE, 'p-1': DocumentOwnershipLevel.OBSERVER },
        },
        {
            _id: 'i-hidden',
            name: 'Hidden',
            ownership: { default: DocumentOwnershipLevel.NONE },
        },
    ];
    await store.seed(async () => items);

    assert.equal(store.canReadDocument('i-public', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(store.canReadDocument('i-private', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(store.canReadDocument('i-private', otherPlayer, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(store.canReadDocument('i-hidden', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    // GMs see everything as OWNER.
    assert.equal(store.canReadDocument('i-hidden', gm, DOCUMENT_VISIBILITY.WRITEABLE), true);

    const playerList = store.list({ subject: player, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE });
    assert.deepEqual(playerList.map((i) => i._id).sort(), ['i-private', 'i-public']);
}

async function runListByFolderIds() {
    const store = new ItemStore();
    const items: RawItem[] = [
        { _id: 'i-1', folder: 'f-1', ownership: { default: DocumentOwnershipLevel.OBSERVER } },
        { _id: 'i-2', folder: 'f-2', ownership: { default: DocumentOwnershipLevel.OBSERVER } },
        { _id: 'i-3', folder: null, ownership: { default: DocumentOwnershipLevel.OBSERVER } },
        { _id: 'i-4', folder: 'f-1', ownership: { default: DocumentOwnershipLevel.NONE } },
    ];
    await store.seed(async () => items);

    const allF1 = store.listByFolderIds(['f-1']);
    assert.deepEqual(allF1.map((i) => i._id).sort(), ['i-1', 'i-4']);

    const playerF1 = store.listByFolderIds(['f-1'], { subject: player, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE });
    assert.deepEqual(playerF1.map((i) => i._id), ['i-1']);

    const rootOnly = store.listByFolderIds([null]);
    assert.deepEqual(rootOnly.map((i) => i._id), ['i-3']);
}

async function runEmbeddedActiveEffectRouting() {
    const store = new ItemStore();
    await store.seed(async () => [
        {
            _id: 'i-with-effects',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
            effects: [
                { _id: 'fx-existing', name: 'Existing Effect' },
            ],
        },
    ] as RawItem[]);

    const events: DocumentChangedEvent[] = [];
    store.on('documentChanged', (e) => events.push(e as DocumentChangedEvent));

    // Create effect via embedded routing (parentUuid: Item.<id>).
    store.applyModifyDocument('ActiveEffect', 'create', [
        { _id: 'fx-new', name: 'New Effect' },
    ], { parentUuid: 'Item.i-with-effects' });
    assert.equal(store.get('i-with-effects')?.effects?.length, 2);
    assert.equal(events.find((e) => e.id === 'i-with-effects')?.action, 'update');

    // Update effect in place.
    store.applyModifyDocument('ActiveEffect', 'update', [
        { _id: 'fx-existing', name: 'Renamed Effect' },
    ], { parentUuid: 'Item.i-with-effects' });
    const renamed = (store.get('i-with-effects')?.effects || []).find(
        (e: any) => e._id === 'fx-existing',
    ) as any;
    assert.equal(renamed?.name, 'Renamed Effect');

    // Idempotent: same update fires no extra event.
    const before = events.length;
    store.applyModifyDocument('ActiveEffect', 'update', [
        { _id: 'fx-existing', name: 'Renamed Effect' },
    ], { parentUuid: 'Item.i-with-effects' });
    assert.equal(events.length, before, 'no-op effect update emits nothing');

    // Delete effect.
    store.applyModifyDocument('ActiveEffect', 'delete', null, {
        parentUuid: 'Item.i-with-effects',
        ids: ['fx-new'],
    });
    assert.equal(store.get('i-with-effects')?.effects?.length, 1);

    // Unknown embedded type silently dropped.
    store.applyModifyDocument('NotAnItemChild', 'create', [{ _id: 'x' }], {
        parentUuid: 'Item.i-with-effects',
    });
    assert.equal(store.get('i-with-effects')?.effects?.length, 1);
}

async function runRepositoryMirrorsWrites() {
    const store = itemStore;
    await store.seed(async () => []);

    const dispatches: Array<{ type: string; action: string; operation: any; parent?: any }> = [];
    const repository = new ItemRepository({
        dispatchDocument: async (type, action, operation, parent) => {
            dispatches.push({ type, action, operation, parent });
            if (type === 'Item' && action === 'create') {
                return {
                    result: [
                        {
                            _id: 'created-item',
                            name: 'Created Item',
                            type: 'Basic',
                            folder: null,
                            ownership: { default: DocumentOwnershipLevel.OBSERVER },
                            effects: [],
                        },
                    ],
                    operation,
                };
            }
            if (type === 'ActiveEffect' && action === 'create') {
                return {
                    result: [{ _id: 'created-fx', name: 'Created Effect' }],
                    operation,
                };
            }
            return { result: [], operation };
        },
    });

    try {
        await repository.create({ name: 'Created Item', type: 'Basic' });
        assert.equal(dispatches[0].type, 'Item');
        assert.equal(dispatches[0].action, 'create');
        assert.equal(store.get('created-item')?.name, 'Created Item');

        await repository.createEffect('created-item', { name: 'Created Effect' });
        const fxDispatch = dispatches.find((d) => d.type === 'ActiveEffect' && d.action === 'create');
        assert.ok(fxDispatch);
        assert.deepEqual(fxDispatch!.parent, { type: 'Item', id: 'created-item' });
        assert.equal(store.get('created-item')?.effects?.length, 1);
        assert.equal((store.get('created-item')?.effects?.[0] as any)?._id, 'created-fx');

        await repository.update('created-item', { name: 'Renamed Item' });
        const uDispatch = dispatches.find((d) => d.type === 'Item' && d.action === 'update');
        assert.ok(uDispatch);
        assert.deepEqual(uDispatch!.operation, {
            updates: [{ _id: 'created-item', name: 'Renamed Item' }],
        });
    } finally {
        store.clear('item-repository-test');
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('item-store.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
