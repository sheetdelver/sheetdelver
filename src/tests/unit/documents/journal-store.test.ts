import { strict as assert } from 'node:assert';
import { JournalRepository } from '@server/core/documents/primary/journals/JournalRepository';
import { JournalStore, journalStore } from '@server/core/documents/primary/journals/JournalStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { createJournalService } from '@server/services/journals/JournalService';
import { createDocumentStore } from '@server/shared/utils/moduleDocumentServices';
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
    await runOrdinarySecretProjection();
    await runListByFolderIds();
    await runEmbeddedPageMutationRouting();
    await runRepositoryMirrorsWrites();
    console.log('  - JournalStore: all checks passed');
}

async function runOrdinarySecretProjection() {
    const html = '<p>PUBLIC</p><section id="s" class="secret"><p>UNREVEALED</p><section class="secret revealed">NESTED HIDDEN</section></section><section class="secret revealed"><p>REVEALED</p><section class="secret">INNER HIDDEN</section></section>';
    await userStore.seed(async () => [
        { _id: 'reader', role: 1 }, { _id: 'owner', role: 1 },
        { _id: 'assistant', role: 3 }, { _id: 'gm', role: 4 },
    ]);
    await journalStore.seed(async () => [{
        _id: 'secrets', name: 'Secrets', content: html, ownership: { default: 2, owner: 3 },
        pages: [
            { _id: 'inherit', ownership: { default: -1 }, text: { content: html, markdown: 'RAW SECRET MARKDOWN' } },
            { _id: 'observed', ownership: { default: 2 }, text: { content: html } },
            { _id: 'page-owned', ownership: { default: 0, reader: 3 }, text: { content: html } },
        ],
    }] as JournalEntryDocument[]);
    const source = journalStore.get('secrets');
    const service = createJournalService();
    try {
        for (const userId of ['reader', 'owner', 'assistant', 'gm']) {
            const client = { userId, fetchByUuid: async () => { throw new Error('raw journal resolver must not be called'); } } as any;
            const sdk = createDocumentStore(client, async () => {});
            const http = await service.getJournalById(client, 'secrets');
            const sdkEntry = await sdk.get('JournalEntry', 'secrets');
            const sdkUuid = await sdk.fetchByUuid('JournalEntry.secrets');
            assert.deepEqual(sdkEntry, sdkUuid);
            assert.deepEqual(http, { ...sdkEntry, folder: null });
            for (const page of (sdkEntry?.pages ?? []) as any[]) {
                const embedded = await sdk.fetchByUuid(`JournalEntry.secrets.JournalEntryPage.${page._id}`);
                assert.deepEqual(embedded, page, 'embedded UUID uses the same current authorized projection');
                const owner = userId === 'gm' || (page._id === 'inherit' && userId === 'owner')
                    || (page._id === 'page-owned' && userId === 'reader');
                if (owner) assert.equal(page.text.content, html, 'owner retains exact raw source');
                else {
                    assert.match(page.text.content, /PUBLIC|REVEALED/);
                    assert.doesNotMatch(JSON.stringify(page), /UNREVEALED|NESTED HIDDEN|INNER HIDDEN|RAW SECRET MARKDOWN/);
                }
            }
            assert.equal((await sdk.list('JournalEntry')).rows[0].pages, undefined);
        }
        const ownerSubject = userStore.createAccessSubject('owner')!;
        assert.equal(journalStore.projectDetail('secrets', ownerSubject)?.pages?.[0].text?.content, html);
        // Simulate an owner saving the untouched source through the real repository.
        let written: unknown;
        await service.updateJournalPage({ userId: 'owner', dispatchDocument: async (_type: string, _action: string, operation: unknown) => {
            written = operation; return { result: [] };
        } } as any, 'secrets', 'inherit', { data: { text: { content: html } } });
        assert.match(JSON.stringify(written), /UNREVEALED/);
        assert.deepEqual(journalStore.get('secrets'), source, 'projection/save fixture never redacts the Store');
        userStore.applyModifyDocument('User', 'update', [{ _id: 'gm', role: 1 }]);
        assert.doesNotMatch(JSON.stringify(await service.getJournalById({ userId: 'gm' } as any, 'secrets')), /UNREVEALED|INNER HIDDEN/);
        userStore.applyModifyDocument('User', 'delete', null, { ids: ['gm'] });
        assert.equal((await service.getJournalById({ userId: 'gm' } as any, 'secrets') as any).status, 404);
    } finally { journalStore.clear(); userStore.clear(); }
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

    // Broadcast-shaped delete: id strings in result, no operation.ids
    // (ADR-0031 — Foundry-side deletions arrive like this).
    store.applyModifyDocument('JournalEntryPage', 'delete', ['page-existing'], {
        parentUuid: 'JournalEntry.j-entry',
    });
    assert.equal(store.get('j-entry')?.pages?.length, 0, 'broadcast-shaped page delete applies');
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
