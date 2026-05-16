import type { RawJournal } from '@server/shared/types/documents';
import { PrimaryDocumentRepository, type DocumentTransport } from '../base/PrimaryDocumentRepository';
import type { ModifyDocumentAction } from '../base/PrimaryDocumentStore';
import { journalStore } from './JournalStore';

/**
 * JournalEntry primary-document Repository. Per-request transport binding
 * routes writes as the requesting user. Foundry broadcasts the resulting
 * modifyDocument event, which lands through `modifyDocumentRouter` into
 * {@link JournalStore.applyModifyDocument} or
 * {@link JournalStore.applyEmbeddedChange} (for `JournalEntryPage`).
 * The initiator-side mirror in {@link dispatchDocument} makes the second
 * apply idempotent via emit-only-on-change.
 *
 * Folder mutations stay on `FolderRepository` even when callers post them
 * through the same journal route surface.
 */
export class JournalRepository extends PrimaryDocumentRepository<RawJournal> {
    constructor(transport: DocumentTransport) {
        super(transport, journalStore);
    }

    async dispatchDocument(
        type: string,
        action: ModifyDocumentAction,
        operation: Record<string, unknown> = {},
        parent?: { type: string; id: string },
    ): Promise<any> {
        return super.dispatchDocument(type, action, operation, parent);
    }

    async create(data: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('JournalEntry', 'create', { data: [data] });
    }

    async update(journalId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('JournalEntry', 'update', {
            updates: [{ _id: journalId, ...updates }],
        });
    }

    async delete(journalId: string): Promise<void> {
        await this.dispatchDocument('JournalEntry', 'delete', { ids: [journalId] });
    }

    /**
     * Create a JournalEntryPage under the given entry. Routes the result
     * through the embedded apply path so the broadcast and the initiator
     * mirror both end up in the entry's `pages` array.
     */
    async createPage(entryId: string, data: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument(
            'JournalEntryPage',
            'create',
            { data: [data] },
            { type: 'JournalEntry', id: entryId },
        );
    }

    async updatePage(entryId: string, pageId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument(
            'JournalEntryPage',
            'update',
            { updates: [{ _id: pageId, ...updates }] },
            { type: 'JournalEntry', id: entryId },
        );
    }

    async deletePage(entryId: string, pageId: string): Promise<void> {
        await this.dispatchDocument(
            'JournalEntryPage',
            'delete',
            { ids: [pageId] },
            { type: 'JournalEntry', id: entryId },
        );
    }
}
