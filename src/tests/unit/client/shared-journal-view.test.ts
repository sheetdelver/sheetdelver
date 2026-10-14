import assert from 'node:assert/strict';
import { createSharedJournalViewReader } from '../../../client/ui/context/sharedJournalView';
import type { JournalEntryDto, SharedJournalView } from '../../../shared/contracts/journals';

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const receipt = (sequence: number) => ({ streamId: 'stream', sequence, shareId: String(sequence) });
export async function run() {
    const opens: Array<ReturnType<typeof deferred<SharedJournalView>>> = [];
    const reads: Array<ReturnType<typeof deferred<JournalEntryDto>>> = [];
    const closed: string[] = [];
    const reader = createSharedJournalViewReader({
        open() { const next = deferred<SharedJournalView>(); opens.push(next); return next.promise; },
        read() { const next = deferred<JournalEntryDto>(); reads.push(next); return next.promise; },
        async close(id) { closed.push(id); },
    });
    const abandoned = reader.read(receipt(1));
    reader.clear();
    opens[0].resolve({ viewId: 'late-open', expiresAt: 100 });
    assert.equal(await abandoned, null);
    assert.deepEqual(closed, ['late-open']);
    assert.equal(reads.length, 0);
    const replaced = reader.read(receipt(2));
    opens[1].resolve({ viewId: 'old', expiresAt: 100 });
    await Promise.resolve();
    const newest = reader.read(receipt(3));
    opens[2].resolve({ viewId: 'new', expiresAt: 100 });
    await Promise.resolve();
    reads[1].resolve({ _id: 'new', name: 'New', folder: null });
    reads[0].resolve({ _id: 'old', name: 'Old', folder: null });
    assert.equal((await newest)?._id, 'new');
    assert.equal(await replaced, null, 'superseded read cannot resurrect an old view');
    assert.deepEqual(closed, ['late-open', 'old']);
    const changed = reader.read(receipt(3));
    assert.equal(opens.length, 3, 'revisions reuse one active lease');
    await Promise.resolve();
    reader.clear();
    reads[2].resolve({ _id: 'late', name: 'Late', folder: null });
    assert.equal(await changed, null);
    const failed = reader.read(receipt(4));
    opens[3].reject(new Error('temporary failure'));
    await assert.rejects(failed, /temporary failure/);
    const retry = reader.read(receipt(4));
    opens[4].resolve({ viewId: 'retry', expiresAt: 100 });
    await Promise.resolve();
    reads[3].resolve({ _id: 'retry', name: 'Retry', folder: null });
    assert.equal((await retry)?._id, 'retry');
    reader.clear();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(closed, ['late-open', 'old', 'new', 'retry']);
    const failedClose = createSharedJournalViewReader({
        open: async () => ({ viewId: 'id', expiresAt: 100 }),
        read: async () => ({ _id: 'j', name: 'J', folder: null }),
        close: async () => { throw new Error('offline close'); },
    });
    await failedClose.read(receipt(5));
    assert.doesNotThrow(() => failedClose.clear());
    await new Promise(resolve => setImmediate(resolve));
}
