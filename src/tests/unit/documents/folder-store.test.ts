import { strict as assert } from 'node:assert';
import { FolderRepository } from '@server/core/documents/primary/folders/FolderRepository';
import { FolderStore, folderStore } from '@server/core/documents/primary/folders/FolderStore';
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
import type { RawFolder } from '@server/shared/types/documents';

const player: DocumentAccessSubject = { userId: 'p-1', role: FoundryUserRole.PLAYER };
const gm: DocumentAccessSubject = { userId: 'gm-1', role: FoundryUserRole.GAMEMASTER };

export async function run() {
    await runSeedAndTreeHelpers();
    await runPermissionPolicy();
    await runBroadcastUpdatesAndInvalidation();
    await runFolderRepositoryMirrorsWrites();
    console.log('  - FolderStore: all checks passed');
}

async function runSeedAndTreeHelpers() {
    const store = new FolderStore();
    await store.seed(async () => [
        {
            _id: 'root',
            name: 'Root',
            type: 'JournalEntry',
            parent: null,
            sort: 10,
            color: '#ff0000',
        },
        {
            _id: 'child',
            name: 'Child',
            type: 'JournalEntry',
            parent: 'root',
        },
        {
            _id: 'grandchild',
            name: 'Grandchild',
            type: 'JournalEntry',
            parent: 'child',
        },
        {
            _id: 'actor-folder',
            name: 'Actor Folder',
            type: 'Actor',
            parent: null,
        },
    ]);

    assert.equal(store.isReady(), true);
    assert.equal(store.get('child')?.parent, 'root');
    assert.deepEqual(store.listByType('JournalEntry').map(folder => folder._id).sort(), [
        'child',
        'grandchild',
        'root',
    ]);
    assert.deepEqual(store.getChildren(null, 'JournalEntry').map(folder => folder._id), ['root']);
    assert.deepEqual(store.getDescendants('root', 'JournalEntry').map(folder => folder._id), [
        'child',
        'grandchild',
    ]);
    assert.deepEqual(store.getAncestors('grandchild').map(folder => folder._id), ['child', 'root']);
    assert.deepEqual(store.getFolderTreeIdsForFolders(['grandchild']).sort(), [
        'child',
        'grandchild',
        'root',
    ]);

    const clone = store.get('root')!;
    clone.name = 'Mutated';
    assert.equal(store.get('root')?.name, 'Root');
}

async function runPermissionPolicy() {
    const store = new FolderStore();
    const folders: RawFolder[] = [
        { _id: 'omitted-permission', name: 'Omitted', type: 'JournalEntry', parent: null },
        {
            _id: 'default-visible',
            name: 'Default Visible',
            type: 'JournalEntry',
            parent: null,
            permission: { default: DocumentOwnershipLevel.OBSERVER },
        },
        {
            _id: 'user-owner',
            name: 'User Owner',
            type: 'JournalEntry',
            parent: null,
            permission: { 'p-1': DocumentOwnershipLevel.OWNER },
        },
        {
            _id: 'role-visible',
            name: 'Role Visible',
            type: 'JournalEntry',
            parent: null,
            permission: { [String(FoundryUserRole.PLAYER)]: DocumentOwnershipLevel.OBSERVER },
        },
        {
            _id: 'inherited-visible',
            name: 'Inherited Visible',
            type: 'JournalEntry',
            parent: 'default-visible',
            permission: { default: DocumentOwnershipLevel.INHERIT },
        },
        {
            _id: 'missing-parent',
            name: 'Missing Parent',
            type: 'JournalEntry',
            parent: 'nope',
            permission: { default: DocumentOwnershipLevel.INHERIT },
        },
        {
            _id: 'cycle-a',
            name: 'Cycle A',
            type: 'JournalEntry',
            parent: 'cycle-b',
            permission: { default: DocumentOwnershipLevel.INHERIT },
        },
        {
            _id: 'cycle-b',
            name: 'Cycle B',
            type: 'JournalEntry',
            parent: 'cycle-a',
            permission: { default: DocumentOwnershipLevel.INHERIT },
        },
    ];
    await store.seed(async () => folders);

    assert.equal(
        store.canReadDocument('omitted-permission', player, DOCUMENT_VISIBILITY.LIST_VISIBLE),
        false,
        'omitted permission map fails closed to NONE',
    );
    assert.equal(store.canReadDocument('default-visible', player, DOCUMENT_VISIBILITY.DETAIL_VISIBLE), true);
    assert.equal(store.canReadDocument('user-owner', player, DOCUMENT_VISIBILITY.WRITEABLE), true);
    assert.equal(store.canReadDocument('role-visible', player, DOCUMENT_VISIBILITY.DETAIL_VISIBLE), true);
    assert.equal(store.canReadDocument('inherited-visible', player, DOCUMENT_VISIBILITY.DETAIL_VISIBLE), true);
    assert.equal(store.canReadDocument('missing-parent', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(store.canReadDocument('cycle-a', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(store.canReadDocument('omitted-permission', gm, DOCUMENT_VISIBILITY.WRITEABLE), true);
}

async function runBroadcastUpdatesAndInvalidation() {
    const store = new FolderStore();
    await store.seed(async () => [
        {
            _id: 'root',
            name: 'Root',
            type: 'JournalEntry',
            parent: null,
            permission: { default: DocumentOwnershipLevel.NONE },
        },
        {
            _id: 'child',
            name: 'Child',
            type: 'JournalEntry',
            parent: 'root',
            permission: { default: DocumentOwnershipLevel.NONE },
        },
    ]);

    const changes: DocumentChangedEvent[] = [];
    const invalidations: DocumentListInvalidatedEvent[] = [];
    store.on('documentChanged', event => changes.push(event as DocumentChangedEvent));
    store.on('documentListInvalidated', event => invalidations.push(event as DocumentListInvalidatedEvent));

    store.applyModifyDocument('Folder', 'update', [{ _id: 'child', parent: null }]);
    assert.equal(store.get('child')?.parent, null);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, 'update');
    assert.equal(invalidations.at(-1)?.reason, 'folder-tree-changed');

    store.applyModifyDocument('Folder', 'update', [
        { _id: 'child', permission: { default: DocumentOwnershipLevel.OBSERVER } },
    ]);
    assert.equal(changes.length, 2);
    assert.equal(invalidations.at(-1)?.reason, 'folder-permission-changed');

    store.applyModifyDocument('Folder', 'update', [
        { _id: 'child', permission: { default: DocumentOwnershipLevel.OBSERVER } },
    ]);
    assert.equal(changes.length, 2, 'idempotent update emits no duplicate change');
}

async function runFolderRepositoryMirrorsWrites() {
    const store = folderStore;
    await store.seed(async () => []);

    const dispatches: Array<{ type: string; action: string; operation: any }> = [];
    const repository = new FolderRepository({
        dispatchDocument: async (type, action, operation) => {
            dispatches.push({ type, action, operation });
            if (action === 'create') {
                return {
                    result: [
                        {
                            _id: 'created-folder',
                            name: 'Created Folder',
                            type: 'JournalEntry',
                            parent: null,
                        },
                    ],
                    operation,
                };
            }
            if (action === 'update') {
                return {
                    result: [
                        {
                            _id: 'created-folder',
                            parent: 'parent-folder',
                        },
                    ],
                    operation,
                };
            }
            return { result: [], operation };
        },
    });

    try {
        await repository.create({ name: 'Created Folder', type: 'JournalEntry', parent: null });
        assert.deepEqual(dispatches[0], {
            type: 'Folder',
            action: 'create',
            operation: {
                data: [{ name: 'Created Folder', type: 'JournalEntry', parent: null }],
            },
        });
        assert.equal(store.get('created-folder')?.parent, null);

        await repository.update('created-folder', { parent: 'parent-folder' });
        assert.deepEqual(dispatches[1], {
            type: 'Folder',
            action: 'update',
            operation: {
                updates: [{ _id: 'created-folder', parent: 'parent-folder' }],
            },
        });
        assert.equal(store.get('created-folder')?.parent, 'parent-folder');
    } finally {
        store.clear('folder-repository-test');
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('folder-store.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
