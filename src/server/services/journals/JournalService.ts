import type {
    JournalClientLike,
    JournalMutationBody,
    JournalDeleteQuery,
    JournalEntryDocument,
    FolderDocument,
} from '@server/shared/types/documents';
import type {
    JournalListPayload,
    JournalEntryDto,
    JournalErrorPayload,
} from '@shared/contracts/journals';
import {
    DOCUMENT_VISIBILITY,
    isAssistantGM,
} from '@server/core/documents/primary/base/ownership';
import { FolderRepository } from '@server/core/documents/primary/folders/FolderRepository';
import { folderStore } from '@server/core/documents/primary/folders/FolderStore';
import { JournalRepository } from '@server/core/documents/primary/journals/JournalRepository';
import { journalStore } from '@server/core/documents/primary/journals/JournalStore';
import { PrimaryDocumentCacheNotReadyError } from '@server/core/documents/primary/errors';
import { userStore } from '@server/core/documents/primary/users/UserStore';

export function createJournalService() {
    const getStringField = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
    const getNullableStringField = (value: unknown): string | null => typeof value === 'string' ? value : null;
    const getNumberField = (value: unknown, fallback = 0): number => typeof value === 'number' ? value : fallback;
    const createFolderRepository = (client: JournalClientLike): FolderRepository => new FolderRepository({
        dispatchDocument: (
            type: string,
            action: string,
            operation?: unknown,
            parent?: { type: string; id: string },
        ) => client.dispatchDocument(type, action, operation, parent),
    });
    const createJournalRepository = (client: JournalClientLike): JournalRepository => new JournalRepository({
        dispatchDocument: (
            type: string,
            action: string,
            operation?: unknown,
            parent?: { type: string; id: string },
        ) => client.dispatchDocument(type, action, operation, parent),
    });

    const toJournalDto = (journal: JournalEntryDocument): JournalEntryDto => ({
        ...journal,
        _id: String(journal._id || journal.id || ''),
        name: getStringField(journal.name),
        folder: (journal.folder ?? null) as string | null,
    });

    const toJournalListDto = (journal: JournalEntryDocument): JournalEntryDto => ({
        // Foundry's journal directory exposes metadata, not embedded page bodies.
        // Selecting fields here prevents the service-account cache from placing
        // page text, flags, or other full-document data in a list response.
        id: typeof journal.id === 'string' ? journal.id : undefined,
        _id: String(journal._id || journal.id || ''),
        name: getStringField(journal.name),
        folder: (journal.folder ?? null) as string | null,
        ownership: journal.ownership,
        sort: journal.sort,
    });

    const toFolderDto = (folder: FolderDocument) => ({
        ...folder,
        _id: String(folder._id || folder.id || ''),
        name: String(folder.name || ''),
        type: String(folder.type || ''),
        // FolderStore normally supplies parent; the canonical Foundry field is
        // retained as a defensive fallback for mixed/bootstrap payloads.
        parent: (folder.parent ?? folder.folder ?? null) as string | null,
        sort: getNumberField(folder['sort']),
        sorting: folder.sorting === 'm' ? 'm' as const : 'a' as const,
        color: getNullableStringField(folder['color']),
    });

    // Journal list projection with Foundry visibility filtering and folder ancestry pruning.
    const listJournals = async (client: JournalClientLike): Promise<JournalListPayload> => {
        if (!folderStore.isReady()) throw new PrimaryDocumentCacheNotReadyError('Folder');
        if (!journalStore.isReady()) throw new PrimaryDocumentCacheNotReadyError('JournalEntry');

        const currentUserId = client.userId;
        const subject = userStore.createAccessSubject(currentUserId);
        // ASSISTANT-GM and above see every folder regardless of contents; players
        // only see folders that ancestor at least one journal they can read.
        const isAssistantGm = !!subject && isAssistantGM(subject);

        const allFolders = folderStore.listByType('JournalEntry');
        const visibleJournals = subject
            // LIMITED journals are map-note/image hints in Foundry, not journal
            // directory entries. Directory listing therefore begins at OBSERVER.
            ? journalStore.list({ subject, minOwnership: DOCUMENT_VISIBILITY.DETAIL_VISIBLE })
            : [];

        const visibleFolderIds = new Set(folderStore.getFolderTreeIdsForFolders(
            visibleJournals
                .map(j => j.folder)
                .filter((folderId): folderId is string => typeof folderId === 'string' && folderId.length > 0),
        ));
        const visibleFolders = allFolders.filter((f) => isAssistantGm || (!!f._id && visibleFolderIds.has(f._id)));

        return {
            journals: visibleJournals.map(toJournalListDto),
            folders: visibleFolders.map(toFolderDto),
        };
    };

    // Journal create orchestration (JournalEntry and Folder document types).
    const createJournal = async (client: JournalClientLike, body: JournalMutationBody) => {
        const { type, data } = body;
        if (type === 'Folder') return createFolderRepository(client).create(data);
        return createJournalRepository(client).create(data);
    };

    // Journal detail fetch — reads from JournalStore with ownership filtering.
    // Shared-content `showEntry` sends a UUID reference and the client hydrates
    // through this route; ownership is enforced here.
    const getJournalById = async (
        client: JournalClientLike,
        journalId: string
    ): Promise<JournalEntryDto | JournalErrorPayload> => {
        if (!journalStore.isReady()) throw new PrimaryDocumentCacheNotReadyError('JournalEntry');
        const subject = userStore.createAccessSubject(client.userId);
        const doc = subject
            ? journalStore.get(journalId, { subject, minOwnership: DOCUMENT_VISIBILITY.DETAIL_VISIBLE })
            : null;
        if (!doc) return { error: 'Journal not found', status: 404 };

        // Filter embedded pages to the subset the subject can read.
        if (subject) {
            doc.pages = journalStore.visiblePages(journalId, subject, DOCUMENT_VISIBILITY.DETAIL_VISIBLE);
        }

        return toJournalDto(doc);
    };

    const updateJournal = async (client: JournalClientLike, journalId: string, body: JournalMutationBody) => {
        const { type, data } = body;
        if (type === 'Folder') return createFolderRepository(client).update(journalId, data);
        return createJournalRepository(client).update(journalId, data);
    };

    const updateJournalPage = async (
        client: JournalClientLike,
        journalId: string,
        pageId: string,
        body: JournalMutationBody,
    ) => {
        // JournalEntryPage is an embedded document in Foundry v13 and v14;
        // preserve that boundary so cache mirroring merges a child delta.
        return createJournalRepository(client).updatePage(journalId, pageId, body.data);
    };

    const deleteJournal = async (client: JournalClientLike, journalId: string, query: JournalDeleteQuery) => {
        const { type } = query;
        const resolvedType = Array.isArray(type) ? type[0] : type;
        if (resolvedType === 'Folder') return createFolderRepository(client).delete(journalId);
        await createJournalRepository(client).delete(journalId);
        return { _id: journalId };
    };

    return {
        listJournals,
        createJournal,
        getJournalById,
        updateJournal,
        updateJournalPage,
        deleteJournal
    };
}
