import { strict as assert } from 'node:assert';
import { RollTableStore, rollTableStore } from '@server/core/documents/primary/roll-tables/RollTableStore';
import { RollTableRepository } from '@server/core/documents/primary/roll-tables/RollTableRepository';
import {
    DOCUMENT_VISIBILITY,
    DocumentOwnershipLevel,
    FoundryUserRole,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import type { DocumentChangedEvent } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import type { RollTableDocument } from '@server/shared/types/documents';

const player: DocumentAccessSubject = { userId: 'p-1', role: FoundryUserRole.PLAYER };
const otherPlayer: DocumentAccessSubject = { userId: 'p-2', role: FoundryUserRole.PLAYER };
const gm: DocumentAccessSubject = { userId: 'gm-1', role: FoundryUserRole.GAMEMASTER };

export async function run() {
    await runSeedAndCloneOnRead();
    await runOwnershipPolicy();
    await runListByFolderIds();
    await runEmbeddedResultRouting();
    await runRepositoryMirrorsWrites();
    console.log('  - RollTableStore: all checks passed');
}

async function runSeedAndCloneOnRead() {
    const store = new RollTableStore();
    await store.seed(async () => [
        {
            _id: 't-1',
            name: 'Wandering Monsters',
            formula: '1d20',
            folder: 'folder-1',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
            results: [
                { _id: 'r-1', text: 'Goblin', drawn: false, range: [1, 5] },
            ],
        },
    ]);

    assert.equal(store.isReady(), true);
    assert.equal(store.list().length, 1);

    const clone = store.get('t-1')!;
    clone.name = 'Mutated';
    assert.equal(store.get('t-1')?.name, 'Wandering Monsters');
}

async function runOwnershipPolicy() {
    const store = new RollTableStore();
    const tables: RollTableDocument[] = [
        {
            _id: 't-public',
            name: 'Public',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
        },
        {
            _id: 't-private',
            name: 'Private',
            ownership: { default: DocumentOwnershipLevel.NONE, 'p-1': DocumentOwnershipLevel.OBSERVER },
        },
        {
            _id: 't-hidden',
            name: 'Hidden',
            ownership: { default: DocumentOwnershipLevel.NONE },
        },
    ];
    await store.seed(async () => tables);

    assert.equal(store.canReadDocument('t-public', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(store.canReadDocument('t-private', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(store.canReadDocument('t-private', otherPlayer, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(store.canReadDocument('t-hidden', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(store.canReadDocument('t-hidden', gm, DOCUMENT_VISIBILITY.WRITEABLE), true);

    const playerList = store.list({ subject: player, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE });
    assert.deepEqual(playerList.map((t) => t._id).sort(), ['t-private', 't-public']);
}

async function runListByFolderIds() {
    const store = new RollTableStore();
    const tables: RollTableDocument[] = [
        { _id: 't-1', folder: 'f-1', ownership: { default: DocumentOwnershipLevel.OBSERVER } },
        { _id: 't-2', folder: 'f-2', ownership: { default: DocumentOwnershipLevel.OBSERVER } },
        { _id: 't-3', folder: null, ownership: { default: DocumentOwnershipLevel.OBSERVER } },
        { _id: 't-4', folder: 'f-1', ownership: { default: DocumentOwnershipLevel.NONE } },
    ];
    await store.seed(async () => tables);

    const allF1 = store.listByFolderIds(['f-1']);
    assert.deepEqual(allF1.map((t) => t._id).sort(), ['t-1', 't-4']);

    const playerF1 = store.listByFolderIds(['f-1'], { subject: player, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE });
    assert.deepEqual(playerF1.map((t) => t._id), ['t-1']);

    const rootOnly = store.listByFolderIds([null]);
    assert.deepEqual(rootOnly.map((t) => t._id), ['t-3']);
}

async function runEmbeddedResultRouting() {
    const store = new RollTableStore();
    await store.seed(async () => [
        {
            _id: 't-with-results',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
            results: [
                { _id: 'r-1', text: 'Goblin', drawn: false },
            ],
        },
    ] as RollTableDocument[]);

    const events: DocumentChangedEvent[] = [];
    store.on('documentChanged', (e) => events.push(e as DocumentChangedEvent));

    // Create result via embedded routing (parentUuid: RollTable.<id>).
    store.applyModifyDocument('TableResult', 'create', [
        { _id: 'r-2', text: 'Orc', drawn: false },
    ], { parentUuid: 'RollTable.t-with-results' });
    assert.equal(store.get('t-with-results')?.results?.length, 2);
    assert.equal(events.find((e) => e.id === 't-with-results')?.action, 'update');

    // Update result in place — `drawn` flip is the common case.
    store.applyModifyDocument('TableResult', 'update', [
        { _id: 'r-1', drawn: true },
    ], { parentUuid: 'RollTable.t-with-results' });
    const r1 = (store.get('t-with-results')?.results || []).find((r: any) => r._id === 'r-1') as any;
    assert.equal(r1?.drawn, true);

    // Idempotent: same update fires no extra event.
    const before = events.length;
    store.applyModifyDocument('TableResult', 'update', [
        { _id: 'r-1', drawn: true },
    ], { parentUuid: 'RollTable.t-with-results' });
    assert.equal(events.length, before, 'no-op result update emits nothing');

    // Delete result.
    store.applyModifyDocument('TableResult', 'delete', null, {
        parentUuid: 'RollTable.t-with-results',
        ids: ['r-2'],
    });
    assert.equal(store.get('t-with-results')?.results?.length, 1);

    // Unknown embedded type silently dropped.
    store.applyModifyDocument('NotARollTableChild', 'create', [{ _id: 'x' }], {
        parentUuid: 'RollTable.t-with-results',
    });
    assert.equal(store.get('t-with-results')?.results?.length, 1);

    // Broadcast-shaped delete: id strings in result, no operation.ids
    // (ADR-0031 — Foundry-side deletions arrive like this).
    store.applyModifyDocument('TableResult', 'delete', ['r-1'], {
        parentUuid: 'RollTable.t-with-results',
    });
    assert.equal(store.get('t-with-results')?.results?.length, 0, 'broadcast-shaped result delete applies');
}

async function runRepositoryMirrorsWrites() {
    const store = rollTableStore;
    await store.seed(async () => []);

    const dispatches: Array<{ type: string; action: string; operation: any; parent?: any }> = [];
    const repository = new RollTableRepository({
        dispatchDocument: async (type, action, operation, parent) => {
            dispatches.push({ type, action, operation, parent });
            if (type === 'RollTable' && action === 'create') {
                return {
                    result: [
                        {
                            _id: 'created-table',
                            name: 'Created Table',
                            formula: '1d20',
                            folder: null,
                            ownership: { default: DocumentOwnershipLevel.OBSERVER },
                            results: [],
                        },
                    ],
                    operation,
                };
            }
            if (type === 'TableResult' && action === 'create') {
                return {
                    result: [{ _id: 'created-result', text: 'New Entry', drawn: false }],
                    operation,
                };
            }
            return { result: [], operation };
        },
    });

    try {
        await repository.create({ name: 'Created Table', formula: '1d20' });
        assert.equal(dispatches[0].type, 'RollTable');
        assert.equal(dispatches[0].action, 'create');
        assert.equal(store.get('created-table')?.name, 'Created Table');

        await repository.createResult('created-table', { text: 'New Entry' });
        const rDispatch = dispatches.find((d) => d.type === 'TableResult' && d.action === 'create');
        assert.ok(rDispatch);
        assert.deepEqual(rDispatch!.parent, { type: 'RollTable', id: 'created-table' });
        assert.equal(store.get('created-table')?.results?.length, 1);
        assert.equal((store.get('created-table')?.results?.[0] as any)?._id, 'created-result');

        await repository.update('created-table', { name: 'Renamed Table' });
        const uDispatch = dispatches.find((d) => d.type === 'RollTable' && d.action === 'update');
        assert.ok(uDispatch);
        assert.deepEqual(uDispatch!.operation, {
            updates: [{ _id: 'created-table', name: 'Renamed Table' }],
        });
    } finally {
        store.clear('roll-table-repository-test');
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('roll-table-store.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
