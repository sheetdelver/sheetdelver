import type { RawFolder } from '@server/shared/types/documents';
import { PrimaryDocumentRepository, type DocumentTransport } from '../base/PrimaryDocumentRepository';
import type { ModifyDocumentAction } from '../base/PrimaryDocumentStore';
import { folderStore } from './FolderStore';

function normalizeFolderInput(data: Record<string, unknown>): Record<string, unknown> {
    const normalized = { ...data };
    if (normalized.parent === undefined && normalized.folder !== undefined) {
        normalized.parent = normalized.folder;
    }
    delete normalized.folder;
    return normalized;
}

/**
 * Folder primary-document Repository. All Folder writes go through the same
 * request-scoped Repository path as other primary documents so Foundry enforces
 * the acting user's permissions and the FolderStore mirrors mutation results.
 */
export class FolderRepository extends PrimaryDocumentRepository<RawFolder> {
    constructor(transport: DocumentTransport) {
        super(transport, folderStore);
    }

    async dispatchDocument(
        type: string,
        action: ModifyDocumentAction,
        operation: Record<string, unknown> = {},
        parent?: { type: string; id: string },
    ): Promise<any> {
        return super.dispatchDocument(type, action, operation, parent);
    }

    async create(folderData: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('Folder', 'create', { data: [normalizeFolderInput(folderData)] });
    }

    async update(folderId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('Folder', 'update', {
            updates: [{ _id: folderId, ...normalizeFolderInput(updates) }],
        });
    }

    async delete(folderId: string): Promise<void> {
        await this.dispatchDocument('Folder', 'delete', { ids: [folderId] });
    }
}
