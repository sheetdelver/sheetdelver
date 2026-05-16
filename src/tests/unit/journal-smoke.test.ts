import { strict as assert } from 'node:assert';
import { createJournalService } from '@server/services/journals/JournalService';
import { userStore } from '@server/core/documents/primary/users/UserStore';

async function runJournalSmokeTests() {
    const dispatchCalls: Array<{ collection: string; action: string; payload: unknown }> = [];

    const journalService = createJournalService();
    await userStore.seed(async () => [
        { _id: 'user-1', id: 'user-1', role: 2 },
    ]);

    const client = {
        userId: 'user-1',
        getJournals: async () => ([
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
                ownership: { default: 1 },
            },
            {
                _id: 'j-visible-2',
                id: 'j-visible-2',
                name: 'Visible Root Journal',
                folder: null,
                ownership: { default: 2 },
            },
        ]),
        getFolders: async () => ([
            {
                _id: 'folder-root',
                id: 'folder-root',
                name: 'Root Folder',
                type: 'JournalEntry',
                folder: null,
            },
            {
                _id: 'folder-child',
                id: 'folder-child',
                name: 'Child Folder',
                type: 'JournalEntry',
                folder: 'folder-root',
            },
            {
                _id: 'folder-hidden',
                id: 'folder-hidden',
                name: 'Hidden Folder',
                type: 'JournalEntry',
                folder: null,
            },
        ]),
        dispatchDocumentSocket: async (collection: string, action: string, payload: unknown) => {
            dispatchCalls.push({ collection, action, payload });

            if (collection === 'JournalEntry' && action === 'get') {
                return {
                    result: [
                        {
                            _id: 'j-visible-1',
                            id: 'j-visible-1',
                            name: 'Visible Journal',
                            folder: 'folder-child',
                        },
                    ],
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

    const updatePayload = await journalService.updateJournal(client, 'j-visible-1', {
        data: { name: 'Renamed Journal' },
    } as any);

    assert.deepEqual(updatePayload, { ok: true });

    const updateCall = dispatchCalls.find((call) => call.collection === 'JournalEntry' && call.action === 'update');
    assert.ok(updateCall);
    assert.deepEqual(updateCall!.payload, {
        updates: [{ _id: 'j-visible-1', name: 'Renamed Journal' }],
        broadcast: true,
    });
}

export async function run() {
    try {
        await runJournalSmokeTests();
    } finally {
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
