import type {
    JournalClientLike,
    JournalMutationBody,
    JournalDeleteQuery,
    RawJournal,
    RawFolder,
} from '@server/shared/types/documents';
import type {
    JournalListPayload,
    JournalEntryDto,
    JournalErrorPayload,
} from '@shared/contracts/journals';
import {
    DOCUMENT_VISIBILITY,
    FoundryUserRole,
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

    const toJournalDto = (journal: RawJournal): JournalEntryDto => ({
        ...journal,
        _id: String(journal._id || journal.id || ''),
        name: getStringField(journal.name),
        folder: (journal.folder ?? null) as string | null,
    });

    const toFolderDto = (folder: RawFolder) => ({
        ...folder,
        _id: String(folder._id || folder.id || ''),
        name: String(folder.name || ''),
        type: String(folder.type || ''),
        folder: (folder.parent ?? folder.folder ?? null) as string | null,
        sort: getNumberField(folder['sort']),
        color: getNullableStringField(folder['color']),
    });

    // Journal list projection with Foundry visibility filtering and folder ancestry pruning.
    const listJournals = async (client: JournalClientLike): Promise<JournalListPayload> => {
        if (!folderStore.isReady()) throw new PrimaryDocumentCacheNotReadyError('Folder');
        if (!journalStore.isReady()) throw new PrimaryDocumentCacheNotReadyError('JournalEntry');

        const currentUserId = client.userId;
        const subject = userStore.createAccessSubject(currentUserId);
        const isGM = !!subject && subject.role >= FoundryUserRole.ASSISTANT;

        const allFolders = folderStore.listByType('JournalEntry');
        const visibleJournals = subject
            ? journalStore.list({ subject, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE })
            : [];

        const visibleFolderIds = new Set(folderStore.getFolderTreeIdsForFolders(
            visibleJournals
                .map(j => j.folder)
                .filter((folderId): folderId is string => typeof folderId === 'string' && folderId.length > 0),
        ));
        const visibleFolders = allFolders.filter((f) => isGM || (!!f._id && visibleFolderIds.has(f._id)));

        return {
            journals: visibleJournals.map(toJournalDto),
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
        deleteJournal
    };
}
