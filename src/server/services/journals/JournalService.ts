import type {
    JournalClientLike,
    JournalMutationBody,
    JournalDeleteQuery,
    RawJournal,
    RawFolder,
    DocumentSocketResponse,
} from '@server/shared/types/documents';
import type {
    JournalListPayload,
    JournalEntryDto,
    JournalErrorPayload,
} from '@shared/contracts/journals';
import { FoundryUserRole } from '@server/core/documents/primary/base/ownership';
import { userStore } from '@server/core/documents/primary/users/UserStore';

export function createJournalService() {
    const getStringField = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
    const getNullableStringField = (value: unknown): string | null => typeof value === 'string' ? value : null;
    const getNumberField = (value: unknown, fallback = 0): number => typeof value === 'number' ? value : fallback;

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
        folder: (folder.folder ?? null) as string | null,
        sort: getNumberField(folder['sort']),
        color: getNullableStringField(folder['color']),
    });

    // Journal list projection with Foundry visibility filtering and folder ancestry pruning.
    const listJournals = async (client: JournalClientLike): Promise<JournalListPayload> => {
        const currentUserId = client.userId;
        const allJournals = await client.getJournals();
        const allFolders = await client.getFolders('JournalEntry');

        const isGM = !!currentUserId && userStore.getRole(currentUserId) >= FoundryUserRole.ASSISTANT;
        const resolvedUserId = currentUserId || undefined;

        const visibleJournals = allJournals.filter((j) => {
            if (isGM) return true;
            const level = (resolvedUserId ? j.ownership?.[resolvedUserId] : undefined) ?? j.ownership?.default ?? 0;
            return level >= 2;
        });

        const getFolderIdsWithVisibleJournals = (): Set<string> => {
            const folderIds = new Set<string>();
            visibleJournals.forEach((j) => {
                if (j.folder) {
                    let currentFolderId: string | null = j.folder;
                    while (currentFolderId) {
                        folderIds.add(currentFolderId);
                        const folder = allFolders.find((f) => f._id === currentFolderId);
                        currentFolderId = folder?.folder || null;
                    }
                }
            });
            return folderIds;
        };

        const visibleFolderIds = getFolderIdsWithVisibleJournals();
        const visibleFolders = allFolders.filter((f) => isGM || (!!f._id && visibleFolderIds.has(f._id)));

        return {
            journals: visibleJournals.map(toJournalDto),
            folders: visibleFolders.map(toFolderDto),
        };
    };

    // Journal create orchestration (JournalEntry and Folder document types).
    const createJournal = async (client: JournalClientLike, body: JournalMutationBody) => {
        const { type, data } = body;
        const result = await client.dispatchDocumentSocket(type || 'JournalEntry', 'create', {
            data: [data],
            broadcast: true
        });
        return result;
    };

    // Journal detail fetch by document ID.
    const getJournalById = async (
        client: JournalClientLike,
        journalId: string
    ): Promise<JournalEntryDto | JournalErrorPayload> => {
        const response = await client.dispatchDocumentSocket('JournalEntry', 'get', {
            query: { _id: journalId },
            broadcast: false
        }) as DocumentSocketResponse<RawJournal>;
        const doc = response.result?.[0];

        if (!doc) return { error: 'Journal not found', status: 404 };
        return toJournalDto(doc);
    };

    const updateJournal = async (client: JournalClientLike, journalId: string, body: JournalMutationBody) => {
        const { type, data } = body;
        const result = await client.dispatchDocumentSocket(type || 'JournalEntry', 'update', {
            updates: [{ ...data, _id: journalId }],
            broadcast: true
        });
        return result;
    };

    const deleteJournal = async (client: JournalClientLike, journalId: string, query: JournalDeleteQuery) => {
        const { type } = query;
        const resolvedType = Array.isArray(type) ? type[0] : type;
        const result = await client.dispatchDocumentSocket(resolvedType || 'JournalEntry', 'delete', {
            ids: [journalId],
            broadcast: true
        });
        return result;
    };

    return {
        listJournals,
        createJournal,
        getJournalById,
        updateJournal,
        deleteJournal
    };
}
