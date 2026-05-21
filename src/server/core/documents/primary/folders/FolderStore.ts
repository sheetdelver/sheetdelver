import type { FolderDocument } from '@server/shared/types/documents';
import {
    cloneDocument,
    getDocumentId,
    getOperationIds,
    isRecord,
    PrimaryDocumentStore,
    stableJson,
    toDocumentArray,
    type ModifyDocumentAction,
    type PrimaryDocumentType,
} from '../base/PrimaryDocumentStore';
import {
    DocumentOwnershipLevel,
    isGM,
    type DocumentAccessSubject,
    type ResolvedDocumentOwnershipLevel,
} from '../base/ownership';

type FolderPermissionMap = Partial<Record<string, DocumentOwnershipLevel>>;

function normalizePermissionMap(value: unknown): FolderPermissionMap | undefined {
    if (!isRecord(value)) return undefined;
    const map: FolderPermissionMap = {};
    for (const [key, level] of Object.entries(value)) {
        if (typeof level === 'number') map[key] = level as DocumentOwnershipLevel;
    }
    return map;
}

function normalizeFolderDocument(folder: FolderDocument): FolderDocument {
    const normalized = cloneDocument(folder) as FolderDocument;
    normalized.parent = normalized.parent ?? null;

    const permission = normalizePermissionMap(normalized.permission);
    if (permission) normalized.permission = permission as Record<string, number>;
    else delete normalized.permission;

    return normalized;
}

function normalizeFolderPatch(folder: FolderDocument): FolderDocument {
    const normalized = cloneDocument(folder) as FolderDocument;

    if (normalized.permission !== undefined) {
        const permission = normalizePermissionMap(normalized.permission);
        if (permission) normalized.permission = permission as Record<string, number>;
        else delete normalized.permission;
    }

    return normalized;
}

function normalizeFolderResult(action: ModifyDocumentAction, result: unknown): unknown {
    if (action === 'delete') return result;
    const normalize = action === 'update' ? normalizeFolderPatch : normalizeFolderDocument;
    if (Array.isArray(result)) {
        return result
            .filter(isRecord)
            .map(folder => normalize(folder as FolderDocument));
    }
    if (isRecord(result)) return normalize(result as FolderDocument);
    return result;
}

function getFolderType(folder: FolderDocument): string | null {
    return typeof folder.type === 'string' ? folder.type : null;
}

function folderMatchesType(folder: FolderDocument, type?: string | null): boolean {
    return !type || getFolderType(folder) === type;
}

function folderId(folder: FolderDocument | null | undefined): string | null {
    return getDocumentId(folder);
}

function comparableFolderState(folder: FolderDocument | null | undefined): string {
    if (!folder) return '';
    return stableJson({
        parent: folder.parent ?? null,
        type: folder.type ?? null,
        children: folder.children ?? null,
        permission: folder.permission ?? null,
    });
}

/**
 * Folder primary-document Store. Folders are their own primary documents; the
 * `type` field describes the contained document collection but this Store does
 * not inspect or validate those contained document payloads.
 */
export class FolderStore extends PrimaryDocumentStore<FolderDocument> {
    public readonly documentType: PrimaryDocumentType = 'Folder';

    protected resolveOwnership(
        folder: FolderDocument,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        if (isGM(subject)) return DocumentOwnershipLevel.OWNER;
        return this.resolveFolderPermission(folder, subject, new Set<string>());
    }

    public async seed(loader: () => Promise<FolderDocument[]>): Promise<void> {
        await super.seed(async () => {
            const folders = await loader();
            return folders.map(normalizeFolderDocument);
        });
    }

    public upsert(folder: FolderDocument): void {
        const normalized = normalizeFolderDocument(folder);
        const id = folderId(normalized);
        const existed = id ? this.documents.has(id) : false;
        const before = id ? comparableFolderState(this.documents.get(id)) : '';
        super.upsert(normalized);
        if (existed) this.emitFolderListInvalidationIfNeeded(id, before);
    }

    public patch(folderIdValue: string, diff: Record<string, unknown>): void {
        const before = comparableFolderState(this.documents.get(folderIdValue));
        const normalized = normalizeFolderPatch(diff as FolderDocument) as Record<string, unknown>;
        super.patch(folderIdValue, normalized);
        this.emitFolderListInvalidationIfNeeded(folderIdValue, before);
    }

    public listByType(type?: string | null): FolderDocument[] {
        return this.list().filter(folder => folderMatchesType(folder, type));
    }

    public listByIds(ids: Iterable<string>, type?: string | null): FolderDocument[] {
        const idSet = new Set(ids);
        return this.listByType(type).filter(folder => {
            const id = folderId(folder);
            return !!id && idSet.has(id);
        });
    }

    public getChildren(parentId: string | null, type?: string | null): FolderDocument[] {
        return this.listByType(type).filter(folder => (folder.parent ?? null) === parentId);
    }

    public getDescendants(parentId: string, type?: string | null): FolderDocument[] {
        const descendants: FolderDocument[] = [];
        const visited = new Set<string>();
        const queue = [parentId];

        while (queue.length > 0) {
            const currentParentId = queue.shift()!;
            for (const child of this.getChildren(currentParentId, type)) {
                const childId = folderId(child);
                if (!childId || visited.has(childId)) continue;
                visited.add(childId);
                descendants.push(child);
                queue.push(childId);
            }
        }

        return descendants;
    }

    public getAncestors(folderIdValue: string): FolderDocument[] {
        const ancestors: FolderDocument[] = [];
        const visited = new Set<string>([folderIdValue]);
        let current = this.documents.get(folderIdValue);

        while (current?.parent) {
            const parentId = current.parent;
            if (visited.has(parentId)) break;
            visited.add(parentId);
            const parent = this.documents.get(parentId);
            if (!parent) break;
            ancestors.push(cloneDocument(parent));
            current = parent;
        }

        return ancestors;
    }

    public getFolderTreeIdsForFolders(folderIds: Iterable<string>): string[] {
        const ids = new Set<string>();
        for (const id of folderIds) {
            ids.add(id);
            for (const ancestor of this.getAncestors(id)) {
                const ancestorId = folderId(ancestor);
                if (ancestorId) ids.add(ancestorId);
            }
        }
        return Array.from(ids);
    }

    protected applySelfChange(
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        const normalizedResult = normalizeFolderResult(action, result);
        const docs = toDocumentArray<FolderDocument>(normalizedResult);
        const ids = action === 'delete'
            ? getOperationIds(operation, docs)
            : docs.map(folderId).filter((id): id is string => Boolean(id));
        const before = new Map(ids.map(id => [id, comparableFolderState(this.documents.get(id))]));

        super.applySelfChange(action, normalizedResult, operation);

        if (action !== 'update') return;
        for (const id of ids) {
            this.emitFolderListInvalidationIfNeeded(id, before.get(id) ?? '');
        }
    }

    private resolveFolderPermission(
        folder: FolderDocument,
        subject: DocumentAccessSubject,
        visited: Set<string>,
    ): ResolvedDocumentOwnershipLevel {
        const permission = normalizePermissionMap(folder.permission);
        const direct = subject.userId ? permission?.[subject.userId] : undefined;
        const role = permission?.[String(subject.role)];
        const fallback = permission?.default;
        const level = direct ?? role ?? fallback ?? DocumentOwnershipLevel.NONE;

        if (level !== DocumentOwnershipLevel.INHERIT) return this.clampResolvedLevel(level);

        const id = folderId(folder);
        const parentId = folder.parent ?? null;
        if (!id || !parentId || visited.has(id)) return DocumentOwnershipLevel.NONE;
        visited.add(id);

        const parent = this.documents.get(parentId);
        if (!parent) return DocumentOwnershipLevel.NONE;
        return this.resolveFolderPermission(parent, subject, visited);
    }

    private clampResolvedLevel(level: DocumentOwnershipLevel): ResolvedDocumentOwnershipLevel {
        if (level >= DocumentOwnershipLevel.OWNER) return DocumentOwnershipLevel.OWNER;
        if (level >= DocumentOwnershipLevel.OBSERVER) return DocumentOwnershipLevel.OBSERVER;
        if (level >= DocumentOwnershipLevel.LIMITED) return DocumentOwnershipLevel.LIMITED;
        return DocumentOwnershipLevel.NONE;
    }

    private emitFolderListInvalidationIfNeeded(folderIdValue: string | null, before: string): void {
        if (!folderIdValue) return;
        const after = comparableFolderState(this.documents.get(folderIdValue));
        if (before === after) return;

        const beforeState = before ? JSON.parse(before) as Record<string, unknown> : {};
        const afterState = after ? JSON.parse(after) as Record<string, unknown> : {};
        const permissionChanged = stableJson(beforeState.permission ?? null) !== stableJson(afterState.permission ?? null);
        const reason = permissionChanged ? 'folder-permission-changed' : 'folder-tree-changed';
        this.emitListInvalidated(reason, { documentId: folderIdValue });
    }
}

export const folderStore = new FolderStore();
