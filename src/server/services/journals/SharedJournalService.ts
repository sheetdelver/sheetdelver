import type { SharedJournalReceipt, SharedJournalView, JournalEntryDto, JournalErrorPayload } from '@shared/contracts/journals';
import { isRecord } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import { journalStore, type JournalStore } from '@server/core/documents/primary/journals/JournalStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { sharedContentStore, JournalViewLimitError, type SharedContentStore } from '@server/core/world/SharedContentStore';
import { isErrorPayload } from '@server/shared/utils/isErrorPayload';

interface RecipientScope { sessionId: string; worldId: string; userId: string }
const unavailable = (): JournalErrorPayload => ({ error: 'This shared journal view is no longer available', status: 404 });
const isViewId = (value: unknown): value is string => typeof value === 'string' && /^[\da-f-]{36}$/i.test(value);

/** Read-only orchestration; authority comes from the recipient's native receipt. */
export function createSharedJournalService(shares: SharedContentStore = sharedContentStore, journals: JournalStore = journalStore) {
    const read = (scope: RecipientScope, viewId: unknown): JournalEntryDto | JournalErrorPayload => {
        if (!isViewId(viewId)) return unavailable();
        if (!journals.isReady()) return { error: 'World journal cache is temporarily unavailable', status: 503 };
        const access = shares.getJournalViewAccess(scope.sessionId, scope.worldId, viewId);
        const subject = userStore.createAccessSubject(scope.userId);
        return access && subject ? journals.projectSharedView(access, subject) ?? unavailable() : unavailable();
    };
    return {
        open(scope: RecipientScope, body: unknown): SharedJournalView | JournalErrorPayload {
            if (!isRecord(body) || Object.keys(body).some(key => !['streamId', 'sequence', 'shareId'].includes(key))
                || typeof body.streamId !== 'string' || !body.streamId || body.streamId.length > 128
                || typeof body.shareId !== 'string' || !body.shareId || body.shareId.length > 128
                || !Number.isSafeInteger(body.sequence) || (body.sequence as number) < 1) {
                return { error: 'A current native journal receipt is required', status: 400 };
            }
            try {
                const view = shares.openJournalView(scope.sessionId, scope.worldId, body as unknown as SharedJournalReceipt);
                if (!view) return unavailable();
                const projection = read(scope, view.viewId);
                if (isErrorPayload(projection)) {
                    shares.closeJournalView(scope.sessionId, scope.worldId, view.viewId);
                    return projection;
                }
                return view;
            } catch (error) {
                if (error instanceof JournalViewLimitError) return { error: 'Too many open shared journal views; close one and retry', status: 429 };
                throw error;
            }
        },
        read,
        close(scope: RecipientScope, viewId: unknown): void {
            if (isViewId(viewId)) shares.closeJournalView(scope.sessionId, scope.worldId, viewId);
        },
    };
}
