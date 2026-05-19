import { strict as assert } from 'node:assert';
import { createJournalService } from '@server/services/journals/JournalService';
import { folderStore } from '@server/core/documents/primary/folders/FolderStore';
import { journalStore } from '@server/core/documents/primary/journals/JournalStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';

async function runJournalSmokeTests() {
    const dispatchCalls: Array<{ collection: string; action: string; payload: unknown }> = [];

    const journalService = createJournalService();
    await userStore.seed(async () => [
        { _id: 'user-1', id: 'user-1', role: 2 },
    ]);
    await folderStore.seed(async () => [
        {
            _id: 'folder-root',
            id: 'folder-root',
            name: 'Root Folder',
            type: 'JournalEntry',
            parent: null,
        },
        {
            _id: 'folder-child',
            id: 'folder-child',
            name: 'Child Folder',
            type: 'JournalEntry',
            parent: 'folder-root',
        },
        {
            _id: 'folder-hidden',
            id: 'folder-hidden',
            name: 'Hidden Folder',
            type: 'JournalEntry',
            parent: null,
        },
    ]);
    await journalStore.seed(async () => [
        {
            _id: 'j-visible-1',
            id: 'j-visible-1',
            name: 'Visible Journal',
            folder: 'folder-child',
            ownership: { default: 2 },
        },
        {
            _id: 'j-hidden-1',
            id: 'j-hidden-1',
            name: 'Hidden Journal',
            folder: 'folder-hidden',
            ownership: { default: 0 },
        },
        {
            _id: 'j-visible-2',
            id: 'j-visible-2',
            name: 'Visible Root Journal',
            folder: null,
            ownership: { default: 2 },
        },
    ]);
    const client = {
        userId: 'user-1',
        dispatchDocument: async (collection: string, action: string, payload: unknown) => {
            dispatchCalls.push({ collection, action, payload });
            if (collection === 'JournalEntry' && action === 'update') {
                return {
                    result: [{ _id: 'j-visible-1', name: 'Renamed Journal' }],
                };
            }
            return { ok: true };
        },
    } as any;

    const listPayload = await journalService.listJournals(client);
    assert.equal(listPayload.journals.length, 2);
    assert.deepEqual(
        listPayload.journals.map((journal) => journal._id).sort(),
        ['j-visible-1', 'j-visible-2']
    );
    assert.deepEqual(
        listPayload.folders.map((folder) => folder._id).sort(),
        ['folder-child', 'folder-root']
    );

    const detailPayload = await journalService.getJournalById(client, 'j-visible-1');
    if ('error' in detailPayload) {
        assert.fail(`Expected journal detail, got error: ${detailPayload.error}`);
    }
    assert.equal(detailPayload._id, 'j-visible-1');
    assert.equal(detailPayload.name, 'Visible Journal');

    // Detail fetch on a hidden entry returns 404 — Store-backed visibility filter.
    const hiddenDetail = await journalService.getJournalById(client, 'j-hidden-1');
    assert.ok('error' in hiddenDetail);
    if ('error' in hiddenDetail) {
        assert.equal(hiddenDetail.status, 404);
    }

    await journalService.updateJournal(client, 'j-visible-1', {
        data: { name: 'Renamed Journal' },
    } as any);

    const updateCall = dispatchCalls.find((call) => call.collection === 'JournalEntry' && call.action === 'update');
    assert.ok(updateCall);
    assert.deepEqual(updateCall!.payload, {
        updates: [{ _id: 'j-visible-1', name: 'Renamed Journal' }],
    });

    await journalService.createJournal(client, {
        type: 'Folder',
        data: { name: 'New Folder', type: 'JournalEntry', parent: null },
    });
    const folderCreateCall = dispatchCalls.find((call) => call.collection === 'Folder' && call.action === 'create');
    assert.ok(folderCreateCall);
    assert.deepEqual(folderCreateCall!.payload, {
        data: [{ name: 'New Folder', type: 'JournalEntry', parent: null }],
    });

    // JournalEntry create routes through JournalRepository.
    await journalService.createJournal(client, {
        type: 'JournalEntry',
        data: { name: 'New Journal', folder: null },
    });
    const journalCreateCall = dispatchCalls.find((call) => call.collection === 'JournalEntry' && call.action === 'create');
    assert.ok(journalCreateCall);
    assert.deepEqual(journalCreateCall!.payload, {
        data: [{ name: 'New Journal', folder: null }],
    });
}

export async function run() {
    try {
        await runJournalSmokeTests();
    } finally {
        journalStore.clear('journal-smoke-test');
        folderStore.clear('journal-smoke-test');
        userStore.clear('journal-smoke-test');
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('journal-smoke.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
