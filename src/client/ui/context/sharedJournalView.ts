import type { JournalEntryDto, SharedJournalReceipt, SharedJournalView } from '@shared/contracts/journals';
import { createCoalescedFetch } from './coalescedFetch';

/** One modal-owned lease; opening/closing cannot race a replacement into view. */
export function createSharedJournalViewReader(api: {
    open: (receipt: SharedJournalReceipt) => Promise<SharedJournalView>;
    read: (viewId: string) => Promise<JournalEntryDto>;
    close: (viewId: string) => Promise<unknown>;
}) {
    let current: { key: string; retired: boolean; open: Promise<SharedJournalView>;
        read: () => Promise<JournalEntryDto | null | void> } | null = null;
    const clear = () => {
        const previous = current;
        current = null;
        if (!previous || previous.retired) return;
        previous.retired = true;
        // Even an open that finishes after closing must relinquish its lease.
        void previous.open.then(view => api.close(view.viewId)).catch(() => { /* Idle expiry bounds failed close delivery. */ });
    };
    return {
        clear,
        async read(receipt: SharedJournalReceipt): Promise<JournalEntryDto | null> {
            const key = JSON.stringify([receipt.streamId, receipt.sequence, receipt.shareId]);
            if (current?.key !== key) {
                clear();
                const state = { key, retired: false, open: api.open(receipt), read: async (): Promise<JournalEntryDto | null | void> => null };
                state.read = createCoalescedFetch(async () => {
                    const view = await state.open;
                    if (state.retired) return null;
                    const data = await api.read(view.viewId);
                    return state.retired ? null : data;
                });
                current = state;
            }
            const state = current;
            try { return (await state.read()) ?? null; }
            catch (error) { if (current === state) clear(); throw error; }
        },
    };
}
