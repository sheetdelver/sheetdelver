import { strict as assert } from 'node:assert';
import { MacroStore, macroStore } from '@server/core/documents/primary/macros/MacroStore';
import { MacroRepository } from '@server/core/documents/primary/macros/MacroRepository';
import {
    DOCUMENT_VISIBILITY,
    DocumentOwnershipLevel,
    FoundryUserRole,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import type { MacroDocument } from '@server/shared/types/documents';

const player: DocumentAccessSubject = { userId: 'p-1', role: FoundryUserRole.PLAYER };
const otherPlayer: DocumentAccessSubject = { userId: 'p-2', role: FoundryUserRole.PLAYER };
const gm: DocumentAccessSubject = { userId: 'gm-1', role: FoundryUserRole.GAMEMASTER };

export async function run() {
    await runSeedAndCloneOnRead();
    await runOwnershipPolicyAndAuthorIsNotPolicy();
    await runListByAuthorAndFolder();
    await runRepositoryMirrorsWrites();
    console.log('  - MacroStore: all checks passed');
}

async function runSeedAndCloneOnRead() {
    const store = new MacroStore();
    await store.seed(async () => [
        {
            _id: 'm-1',
            name: 'Test Alert',
            type: 'script',
            author: 'author-uid',
            scope: 'global',
            command: "alert('Test!');",
            folder: null,
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
        },
    ]);

    assert.equal(store.isReady(), true);
    assert.equal(store.list().length, 1);

    const clone = store.get('m-1')!;
    clone.name = 'Mutated';
    assert.equal(store.get('m-1')?.name, 'Test Alert');
}

async function runOwnershipPolicyAndAuthorIsNotPolicy() {
    const store = new MacroStore();
    const macros: MacroDocument[] = [
        {
            _id: 'm-public',
            name: 'Public',
            author: 'p-1',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
        },
        {
            // Authored by player p-1 but NOT shared via ownership — proves
            // `author` does NOT grant read access on its own.
            _id: 'm-by-p1-but-private',
            name: 'Private but authored by p-1',
            author: 'p-1',
            ownership: { default: DocumentOwnershipLevel.NONE },
        },
        {
            // Shared with p-1 via ownership map — read access comes from this,
            // not from author attribution.
            _id: 'm-shared-with-p1',
            name: 'Shared with p-1',
            author: 'gm-1',
            ownership: { default: DocumentOwnershipLevel.NONE, 'p-1': DocumentOwnershipLevel.OBSERVER },
        },
    ];
    await store.seed(async () => macros);

    assert.equal(store.canReadDocument('m-public', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    // Author attribution alone does NOT grant access (matches Foundry's model).
    assert.equal(store.canReadDocument('m-by-p1-but-private', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(store.canReadDocument('m-shared-with-p1', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(store.canReadDocument('m-shared-with-p1', otherPlayer, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    // GMs see everything as OWNER.
    assert.equal(store.canReadDocument('m-by-p1-but-private', gm, DOCUMENT_VISIBILITY.WRITEABLE), true);
}

async function runListByAuthorAndFolder() {
    const store = new MacroStore();
    const macros: MacroDocument[] = [
        { _id: 'm-1', author: 'p-1', folder: 'f-1', ownership: { default: DocumentOwnershipLevel.OBSERVER } },
        { _id: 'm-2', author: 'p-1', folder: 'f-2', ownership: { default: DocumentOwnershipLevel.OBSERVER } },
        { _id: 'm-3', author: 'p-2', folder: 'f-1', ownership: { default: DocumentOwnershipLevel.OBSERVER } },
        { _id: 'm-4', author: 'p-1', folder: null, ownership: { default: DocumentOwnershipLevel.NONE } },
    ];
    await store.seed(async () => macros);

    const byP1All = store.listByAuthor('p-1');
    assert.deepEqual(byP1All.map((m) => m._id).sort(), ['m-1', 'm-2', 'm-4']);

    // Subject-filtered author lookup — p-1 can't see their own m-4 because
    // ownership.default is NONE (author doesn't grant access).
    const byP1Visible = store.listByAuthor('p-1', { subject: player, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE });
    assert.deepEqual(byP1Visible.map((m) => m._id).sort(), ['m-1', 'm-2']);

    const f1 = store.listByFolderIds(['f-1']);
    assert.deepEqual(f1.map((m) => m._id).sort(), ['m-1', 'm-3']);

    const rootOnly = store.listByFolderIds([null]);
    assert.deepEqual(rootOnly.map((m) => m._id), ['m-4']);
}

async function runRepositoryMirrorsWrites() {
    const store = macroStore;
    await store.seed(async () => []);

    const dispatches: Array<{ type: string; action: string; operation: any; parent?: any }> = [];
    const repository = new MacroRepository({
        dispatchDocument: async (type, action, operation, parent) => {
            dispatches.push({ type, action, operation, parent });
            if (type === 'Macro' && action === 'create') {
                return {
                    result: [
                        {
                            _id: 'created-macro',
                            name: 'Created Macro',
                            type: 'script',
                            author: 'author-uid',
                            scope: 'global',
                            command: '',
                            folder: null,
                            ownership: { default: DocumentOwnershipLevel.OBSERVER },
                        },
                    ],
                    operation,
                };
            }
            return { result: [], operation };
        },
    });

    try {
        await repository.create({ name: 'Created Macro', type: 'script' });
        assert.equal(dispatches[0].type, 'Macro');
        assert.equal(dispatches[0].action, 'create');
        assert.equal(store.get('created-macro')?.name, 'Created Macro');

        await repository.update('created-macro', { name: 'Renamed Macro' });
        const uDispatch = dispatches.find((d) => d.type === 'Macro' && d.action === 'update');
        assert.ok(uDispatch);
        assert.deepEqual(uDispatch!.operation, {
            updates: [{ _id: 'created-macro', name: 'Renamed Macro' }],
        });

        await repository.delete('created-macro');
        const dDispatch = dispatches.find((d) => d.type === 'Macro' && d.action === 'delete');
        assert.ok(dDispatch);
        assert.deepEqual(dDispatch!.operation, { ids: ['created-macro'] });
        assert.equal(store.get('created-macro'), null);
    } finally {
        store.clear('macro-repository-test');
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('macro-store.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
