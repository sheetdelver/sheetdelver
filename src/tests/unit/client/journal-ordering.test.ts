import { strict as assert } from 'node:assert';
import {
    sortDirectorySiblings,
    sortJournalPages,
} from '@client/ui/components/journalOrdering';

export function run() {
    const entries = [
        { _id: 'third', name: 'C', sort: 30 },
        { _id: 'first', name: 'B', sort: 10 },
        { _id: 'second', name: 'A', sort: 20 },
    ];

    assert.deepEqual(
        sortDirectorySiblings(entries, 'm').map(entry => entry._id),
        ['first', 'second', 'third'],
        'manual folder mode follows persisted numeric sort values',
    );
    assert.deepEqual(
        sortDirectorySiblings(entries, 'a').map(entry => entry._id),
        ['second', 'first', 'third'],
        'alphabetical folder mode follows names',
    );
    assert.deepEqual(
        entries.map(entry => entry._id),
        ['third', 'first', 'second'],
        'sorting does not mutate provider DTO arrays',
    );

    assert.deepEqual(
        sortJournalPages([
            { _id: 'page-3', sort: 300 },
            { _id: 'page-1', sort: 100 },
            { _id: 'page-2', sort: 200 },
        ]).map(page => page._id),
        ['page-1', 'page-2', 'page-3'],
        'journal pages follow their persisted numeric order',
    );

    console.log('  - Journal directory/page ordering: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) run();
