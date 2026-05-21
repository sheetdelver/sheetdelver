import { strict as assert } from 'node:assert';
import { JournalRepository } from '@server/core/documents/primary/journals/JournalRepository';
import { JournalStore, journalStore } from '@server/core/documents/primary/journals/JournalStore';
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
import type { JournalEntryDocument } from '@server/shared/types/documents';

const player: DocumentAccessSubject = { userId: 'p-1', role: FoundryUserRole.PLAYER };
const otherPlayer: DocumentAccessSubject = { userId: 'p-2', role: FoundryUserRole.PLAYER };
const gm: DocumentAccessSubject = { userId: 'gm-1', role: FoundryUserRole.GAMEMASTER };

export async function run() {
    await runSeedAndCloneOnRead();
    await runEntryOwnershipPolicy();
    await runPageOwnershipPolicy();
    await runPageInheritResolution();
    await runListByFolderIds();
    await runEmbeddedPageMutationRouting();
    await runRepositoryMirrorsWrites();
    console.log('  - JournalStore: all checks passed');
}

async function runSeedAndCloneOnRead() {
    const store = new JournalStore();
    await store.seed(async () => [
        {
            _id: 'j-1',
            name: 'Journal One',
            folder: 'folder-1',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
            pages: [
                {
                    _id: 'p-1',
                    name: 'Page A',
                    ownership: { default: DocumentOwnershipLevel.OBSERVER },
                },
            ],
        },
    ]);

    assert.equal(store.isReady(), true);
    assert.equal(store.list().length, 1);

    // Defensive clone on read.
    const clone = store.get('j-1')!;
    clone.name = 'Mutated';
    clone.pages![0].name = 'Mutated Page';
    assert.equal(store.get('j-1')?.name, 'Journal One');
    assert.equal(store.get('j-1')?.pages?.[0]?.name, 'Page A');
}

async function runEntryOwnershipPolicy() {
    const store = new JournalStore();
    const entries: JournalEntryDocument[] = [
        {
            _id: 'j-public',
            name: 'Public',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
        },
        {
            _id: 'j-private',
            name: 'Private',
            ownership: { default: DocumentOwnershipLevel.NONE, 'p-1': DocumentOwnershipLevel.OBSERVER },
        },
        {
            _id: 'j-hidden',
            name: 'Hidden',
            ownership: { default: DocumentOwnershipLevel.NONE },
        },
    ];
    await store.seed(async () => entries);

    assert.equal(store.canReadDocument('j-public', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(store.canReadDocument('j-private', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(store.canReadDocument('j-private', otherPlayer, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(store.canReadDocument('j-hidden', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    // GMs see everything as OWNER.
    assert.equal(store.canReadDocument('j-hidden', gm, DOCUMENT_VISIBILITY.WRITEABLE), true);

    const playerList = store.list({ subject: player, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE });
    assert.deepEqual(playerList.map((j) => j._id).sort(), ['j-private', 'j-public']);
}

async function runPageOwnershipPolicy() {
    const store = new JournalStore();
    const entries: JournalEntryDocument[] = [
        {
            _id: 'j-entry',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
            pages: [
                {
                    _id: 'page-public',
                    ownership: { default: DocumentOwnershipLevel.OBSERVER },
                },
                {
                    _id: 'page-private',
                    ownership: { default: DocumentOwnershipLevel.NONE, 'p-1': DocumentOwnershipLevel.OBSERVER },
                },
                {
                    _id: 'page-restricted',
                    ownership: { default: DocumentOwnershipLevel.NONE },
                },
                {
                    // Omitted page ownership fails closed for non-GMs.
                    _id: 'page-bare',
                },
            ],
        },
    ];
    await store.seed(async () => entries);

    assert.equal(store.canReadPage('j-entry', 'page-public', player), true);
    assert.equal(store.canReadPage('j-entry', 'page-private', player), true);
    assert.equal(store.canReadPage('j-entry', 'page-private', otherPlayer), false);
    assert.equal(store.canReadPage('j-entry', 'page-restricted', player), false);
    assert.equal(store.canReadPage('j-entry', 'page-bare', player), false, 'omitted ownership fails closed');
    // GM sees every page.
    assert.equal(store.canReadPage('j-entry', 'page-bare', gm), true);
    assert.equal(store.canReadPage('j-entry', 'page-restricted', gm), true);

    const visible = store.visiblePages('j-entry', player);
    assert.deepEqual(visible.map((p) => p._id).sort(), ['page-private', 'page-public']);

    const gmVisible = store.visiblePages('j-entry', gm);
    assert.equal(gmVisible.length, 4);
}

async function runPageInheritResolution() {
    const store = new JournalStore();
    await store.seed(async () => [
        {
            _id: 'j-inherit',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
            pages: [
                {
                    _id: 'page-inherit',
                    // Explicit INHERIT resolves to the entry's effective ownership.
                    ownership: { default: DocumentOwnershipLevel.INHERIT },
                },
            ],
        },
        {
            _id: 'j-inherit-hidden',
            ownership: { default: DocumentOwnershipLevel.NONE },
            pages: [
                {
                    _id: 'page-inherit-hidden',
                    ownership: { default: DocumentOwnershipLevel.INHERIT },
                },
            ],
        },
    ]);

    // Entry visible → INHERIT pulls OBSERVER from the entry.
    assert.equal(store.canReadPage('j-inherit', 'page-inherit', player), true);
    // Entry not even LIST_VISIBLE → canReadPage fails at the entry gate before page resolution.
    assert.equal(store.canReadPage('j-inherit-hidden', 'page-inherit-hidden', player), false);
}

async function runListByFolderIds() {
    const store = new JournalStore();
    await store.seed(async () => [
        { _id: 'j-1', folder: 'f-1', ownership: { default: DocumentOwnershipLevel.OBSERVER } } as JournalEntryDocument,
        { _id: 'j-2', folder: 'f-2', ownership: { default: DocumentOwnershipLevel.OBSERVER } } as JournalEntryDocument,
        { _id: 'j-3', folder: null, ownership: { default: DocumentOwnershipLevel.OBSERVER } } as JournalEntryDocument,
        { _id: 'j-4', folder: 'f-1', ownership: { default: DocumentOwnershipLevel.NONE } } as JournalEntryDocument,
    ]);

    const allF1 = store.listByFolderIds(['f-1']);
    assert.deepEqual(allF1.map((j) => j._id).sort(), ['j-1', 'j-4']);

    const playerF1 = store.listByFolderIds(['f-1'], { subject: player, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE });
    assert.deepEqual(playerF1.map((j) => j._id), ['j-1']);

    const rootOnly = store.listByFolderIds([null]);
    assert.deepEqual(rootOnly.map((j) => j._id), ['j-3']);
}

async function runEmbeddedPageMutationRouting() {
    const store = new JournalStore();
    await store.seed(async () => [
        {
            _id: 'j-entry',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
            pages: [
                { _id: 'page-existing', name: 'Existing Page', ownership: { default: DocumentOwnershipLevel.OBSERVER } },
            ],
        },
    ]);

    const events: DocumentChangedEvent[] = [];
    store.on('documentChanged', (e) => events.push(e as DocumentChangedEvent));

    // Create page via embedded routing — parentUuid points back to the entry.
    store.applyModifyDocument('JournalEntryPage', 'create', [
        { _id: 'page-new', name: 'New Page', ownership: { default: DocumentOwnershipLevel.OBSERVER } },
    ], { parentUuid: 'JournalEntry.j-entry' });
    assert.equal(store.get('j-entry')?.pages?.length, 2);
    assert.equal(events.find((e) => e.id === 'j-entry')?.action, 'update');

    // Update page in place.
    store.applyModifyDocument('JournalEntryPage', 'update', [
        { _id: 'page-existing', name: 'Renamed' },
    ], { parentUuid: 'JournalEntry.j-entry' });
    assert.equal(store.get('j-entry')?.pages?.find((p) => p._id === 'page-existing')?.name, 'Renamed');

    // Idempotent update (same payload) emits nothing new.
    const before = events.length;
    store.applyModifyDocument('JournalEntryPage', 'update', [
        { _id: 'page-existing', name: 'Renamed' },
    ], { parentUuid: 'JournalEntry.j-entry' });
    assert.equal(events.length, before, 'no-op update emits nothing');

    // Delete page.
    store.applyModifyDocument('JournalEntryPage', 'delete', null, {
        parentUuid: 'JournalEntry.j-entry',
        ids: ['page-new'],
    });
    assert.equal(store.get('j-entry')?.pages?.length, 1);

    // Unknown embedded type drops silently — no page array changes.
    store.applyModifyDocument('NotAJournalChild', 'create', [{ _id: 'x' }], {
        parentUuid: 'JournalEntry.j-entry',
    });
    assert.equal(store.get('j-entry')?.pages?.length, 1);
}

async function runRepositoryMirrorsWrites() {
    const store = journalStore;
    await store.seed(async () => []);

    const dispatches: Array<{ type: string; action: string; operation: any; parent?: any }> = [];
    const repository = new JournalRepository({
        dispatchDocument: async (type, action, operation, parent) => {
            dispatches.push({ type, action, operation, parent });
            if (type === 'JournalEntry' && action === 'create') {
                return {
                    result: [
                        {
                            _id: 'created-journal',
                            name: 'Created Journal',
                            folder: null,
                            ownership: { default: DocumentOwnershipLevel.OBSERVER },
                            pages: [],
                        },
                    ],
                    operation,
                };
            }
            if (type === 'JournalEntryPage' && action === 'create') {
                return {
                    result: [
                        {
                            _id: 'created-page',
                            name: 'Created Page',
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
        await repository.create({ name: 'Created Journal', folder: null });
        assert.equal(dispatches[0].type, 'JournalEntry');
        assert.equal(dispatches[0].action, 'create');
        assert.equal(store.get('created-journal')?.name, 'Created Journal');

        await repository.createPage('created-journal', { name: 'Created Page' });
        const pageDispatch = dispatches.find((d) => d.type === 'JournalEntryPage' && d.action === 'create');
        assert.ok(pageDispatch);
        assert.deepEqual(pageDispatch!.parent, { type: 'JournalEntry', id: 'created-journal' });
        assert.equal(store.get('created-journal')?.pages?.length, 1);
        assert.equal(store.get('created-journal')?.pages?.[0]?._id, 'created-page');
    } finally {
        store.clear('journal-repository-test');
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('journal-store.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
