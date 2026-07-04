import type { JournalEntryDocument, JournalEntryPageDocument } from '@server/shared/types/documents';
import {
    cloneDocument,
    appendCreatedById,
    deepMerge,
    getDocumentId,
    getDeletionIds,
    PrimaryDocumentStore,
    stableJson,
    toDocumentArray,
    type ModifyDocumentAction,
    type PrimaryDocumentType,
} from '../base/PrimaryDocumentStore';
import {
    DocumentOwnershipLevel,
    getEffectiveOwnership,
    isGM,
    type DocumentAccessSubject,
    type DocumentOwnershipMap,
    type ResolvedDocumentOwnershipLevel,
} from '../base/ownership';

function pageId(page: JournalEntryPageDocument | null | undefined): string | null {
    return getDocumentId(page);
}

function clampResolvedLevel(level: DocumentOwnershipLevel): ResolvedDocumentOwnershipLevel {
    if (level >= DocumentOwnershipLevel.OWNER) return DocumentOwnershipLevel.OWNER;
    if (level >= DocumentOwnershipLevel.OBSERVER) return DocumentOwnershipLevel.OBSERVER;
    if (level >= DocumentOwnershipLevel.LIMITED) return DocumentOwnershipLevel.LIMITED;
    return DocumentOwnershipLevel.NONE;
}

/**
 * JournalEntry primary-document Store. Full hydration + bootstrap seed.
 *
 * Visibility (per ADR-0013):
 *   - Entry-level uses the standard `ownership` map. GMs are effective owners.
 *   - Pages use their own `ownership` map with two-level semantics: caller must
 *     read the entry first, then the page's own ownership applies. An explicit
 *     page `INHERIT` (-1) resolves to the entry's effective ownership; omitted
 *     page ownership fails closed (treated as NONE for non-GM subjects).
 *
 * Folder membership is via the document-side `folder` id. JournalStore does not
 * hold Folder docs — `FolderStore` is the source of truth for the folder tree.
 * Folder permissions do not dynamically gate JournalEntry visibility in Foundry
 * v13; folder-level "Configure Ownership" behavior should be modeled as bulk
 * ownership updates on the affected JournalEntry documents, not as a read-time
 * join through FolderStore.
 *
 * Embedded children: `JournalEntryPage` arrives with `parentUuid: JournalEntry.<id>`.
 */
export class JournalStore extends PrimaryDocumentStore<JournalEntryDocument> {
    public readonly documentType: PrimaryDocumentType = 'JournalEntry';

    protected resolveOwnership(
        journal: JournalEntryDocument,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        const ownership = journal.ownership as DocumentOwnershipMap | undefined;
        return getEffectiveOwnership(ownership, subject);
    }

    /**
     * Two-level page visibility: caller must be able to read the entry, then
     * the page's own ownership applies. Explicit `INHERIT` resolves to entry
     * ownership; omitted page ownership fails closed (NONE for non-GM subjects).
     */
    public canReadPage(
        entryId: string,
        pageIdValue: string,
        subject: DocumentAccessSubject,
        minOwnership: ResolvedDocumentOwnershipLevel = DocumentOwnershipLevel.OBSERVER,
    ): boolean {
        const entry = this.documents.get(entryId);
        if (!entry) return false;
        const entryLevel = this.resolveOwnership(entry, subject);
        if (entryLevel < DocumentOwnershipLevel.LIMITED) return false;

        const page = (entry.pages || []).find(p => pageId(p) === pageIdValue);
        if (!page) return false;
        const level = this.resolvePageOwnership(page, entryLevel, subject);
        return level >= minOwnership;
    }

    private resolvePageOwnership(
        page: JournalEntryPageDocument,
        entryEffectiveLevel: ResolvedDocumentOwnershipLevel,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        if (isGM(subject)) return DocumentOwnershipLevel.OWNER;
        const ownership = page.ownership as DocumentOwnershipMap | undefined;
        // Omitted ownership fails closed for non-GMs.
        if (!ownership) return DocumentOwnershipLevel.NONE;
        const raw = ownership[subject.userId] !== undefined
            ? ownership[subject.userId]!
            : ownership.default ?? DocumentOwnershipLevel.NONE;
        if (raw === DocumentOwnershipLevel.INHERIT) return entryEffectiveLevel;
        return clampResolvedLevel(raw);
    }

    /**
     * Return the subset of pages on an entry that a subject can read at the
     * given level. Used by the DTO projection layer so the wire payload doesn't
     * leak pages the caller shouldn't see.
     */
    public visiblePages(
        entryId: string,
        subject: DocumentAccessSubject,
        minOwnership: ResolvedDocumentOwnershipLevel = DocumentOwnershipLevel.OBSERVER,
    ): JournalEntryPageDocument[] {
        const entry = this.documents.get(entryId);
        if (!entry) return [];
        const entryLevel = this.resolveOwnership(entry, subject);
        if (entryLevel < DocumentOwnershipLevel.LIMITED) return [];

        const pages = entry.pages || [];
        return pages
            .filter(page => this.resolvePageOwnership(page, entryLevel, subject) >= minOwnership)
            .map(page => cloneDocument(page));
    }

    /**
     * List journals whose folder id is in the provided set. Used by the DTO
     * projection layer after FolderStore has resolved the visible folder ids
     * for the requesting subject.
     */
    public listByFolderIds(folderIds: Iterable<string | null>, options?: {
        subject?: DocumentAccessSubject;
        minOwnership?: ResolvedDocumentOwnershipLevel;
    }): JournalEntryDocument[] {
        const ids = new Set<string | null>();
        for (const id of folderIds) ids.add(id);

        const filterByFolder = (journals: JournalEntryDocument[]) =>
            journals.filter(journal => ids.has((journal.folder as string | null) ?? null));

        if (options?.subject) {
            const subject = options.subject;
            const threshold = options.minOwnership ?? DocumentOwnershipLevel.LIMITED;
            return filterByFolder(this.list({ subject, minOwnership: threshold }));
        }
        return filterByFolder(this.list());
    }

    /**
     * Embedded JournalEntryPage handling. `parentUuid: JournalEntry.<entryId>`
     * means a page event applies to that entry's `pages` array.
     */
    protected applyEmbeddedChange(
        type: string,
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        if (type !== 'JournalEntryPage') return;
        const entryId = this.getEntryIdFromOperation(operation);
        if (!entryId) return;
        const entry = this.documents.get(entryId);
        if (!entry) return;

        const before = stableJson(entry);
        const docs = toDocumentArray<JournalEntryPageDocument>(result);
        entry.pages = entry.pages || [];

        if (action === 'delete') {
            const ids = getDeletionIds(operation, result, docs);
            entry.pages = entry.pages.filter(page => {
                const id = pageId(page);
                return !id || !ids.includes(id);
            });
        } else if (action === 'update') {
            for (const page of docs) {
                const id = pageId(page);
                if (!id) continue;
                const index = entry.pages.findIndex(existing => pageId(existing) === id);
                if (index >= 0) {
                    deepMerge(entry.pages[index] as Record<string, unknown>, page as Record<string, unknown>);
                }
            }
        } else if (action === 'create') {
            // Idempotent create (mirror + broadcast both apply — ADR-0012).
            entry.pages = appendCreatedById(entry.pages, docs);
        }

        this.documents.set(entryId, entry);
        if (action !== 'get' && stableJson(entry) !== before) {
            this.emitChanged(entryId, 'update');
        }
    }

    private getEntryIdFromOperation(operation?: Record<string, unknown>): string | null {
        if (typeof operation?.parentId === 'string') return operation.parentId;
        if (typeof operation?.parentUuid !== 'string') return null;
        const parts = operation.parentUuid.split('.');
        if (parts[0] === 'JournalEntry') return parts[1] || null;
        return null;
    }
}

export const journalStore = new JournalStore();
