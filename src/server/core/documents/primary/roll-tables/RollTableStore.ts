import type { RollTableDocument, RollTableResultDocument } from '@server/shared/types/documents';
import {
    cloneDocument,
    appendCreatedById,
    deepMerge,
    getDocumentId,
    getDeletionIds,
    isRecord,
    PrimaryDocumentStore,
    stableJson,
    toDocumentArray,
    type ModifyDocumentAction,
    type PrimaryDocumentType,
} from '../base/PrimaryDocumentStore';
import {
    DocumentOwnershipLevel,
    getEffectiveOwnership,
    type DocumentAccessSubject,
    type DocumentOwnershipMap,
    type ResolvedDocumentOwnershipLevel,
} from '../base/ownership';

function resultId(result: unknown): string | null {
    if (!isRecord(result)) return null;
    return getDocumentId(result);
}

/**
 * RollTable primary-document Store. Full hydration + bootstrap seed.
 *
 * Visibility (per ADR-0013): standard `ownership` map — GMs short-circuit to
 * OWNER via `getEffectiveOwnership`; non-GM subjects read explicit user entry
 * or fall back to `ownership.default`. Same policy as Actor, Item, JournalEntry.
 *
 * Embedded children: `RollTableResult` events with `parentUuid: RollTable.<id>`
 * apply to the parent table's `results[]` array. `drawn: boolean` flips through
 * as a normal embedded `update` — no special handling beyond the standard
 * in-place array maintenance.
 */
export class RollTableStore extends PrimaryDocumentStore<RollTableDocument> {
    public readonly documentType: PrimaryDocumentType = 'RollTable';

    protected resolveOwnership(
        table: RollTableDocument,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        const ownership = table.ownership as DocumentOwnershipMap | undefined;
        return getEffectiveOwnership(ownership, subject);
    }

    public listByFolderIds(folderIds: Iterable<string | null>, options?: {
        subject?: DocumentAccessSubject;
        minOwnership?: ResolvedDocumentOwnershipLevel;
    }): RollTableDocument[] {
        const ids = new Set<string | null>();
        for (const id of folderIds) ids.add(id);

        const filterByFolder = (tables: RollTableDocument[]) =>
            tables.filter(table => ids.has((table.folder as string | null) ?? null));

        if (options?.subject) {
            const subject = options.subject;
            const threshold = options.minOwnership ?? DocumentOwnershipLevel.LIMITED;
            return filterByFolder(this.list({ subject, minOwnership: threshold }));
        }
        return filterByFolder(this.list());
    }

    /**
     * Embedded handler for `RollTableResult` events under RollTables. Foundry
     * dispatches these with `parentUuid: RollTable.<id>`; the parent table's
     * `results[]` array is mutated in place and a `documentChanged` (update)
     * fires on the parent so fan-out subscribers refresh.
     */
    protected applyEmbeddedChange(
        type: string,
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        if (type !== 'RollTableResult') return;
        const tableId = this.getTableIdFromOperation(operation);
        if (!tableId) return;
        const table = this.documents.get(tableId);
        if (!table) return;

        const before = stableJson(table);
        const docs = toDocumentArray<Record<string, unknown>>(result);
        const results = [...(table.results || [])];

        if (action === 'delete') {
            const ids = getDeletionIds(operation, result, docs);
            table.results = results.filter(r => {
                const id = resultId(r);
                return !id || !ids.includes(id);
            }) as RollTableResultDocument[];
        } else if (action === 'update') {
            for (const incoming of docs) {
                const id = getDocumentId(incoming);
                if (!id) continue;
                const index = results.findIndex(existing => isRecord(existing) && getDocumentId(existing) === id);
                if (index >= 0 && isRecord(results[index])) {
                    deepMerge(results[index] as Record<string, unknown>, incoming);
                }
            }
            table.results = results as RollTableResultDocument[];
        } else if (action === 'create') {
            // Idempotent create (mirror + broadcast both apply — ADR-0012).
            table.results = appendCreatedById(results, docs as unknown as RollTableResultDocument[]);
        }

        this.documents.set(tableId, table);
        if (action !== 'get' && stableJson(table) !== before) {
            this.emitChanged(tableId, 'update');
        }
    }

    private getTableIdFromOperation(operation?: Record<string, unknown>): string | null {
        if (typeof operation?.parentId === 'string') return operation.parentId;
        if (typeof operation?.parentUuid !== 'string') return null;
        const parts = operation.parentUuid.split('.');
        if (parts[0] === 'RollTable') return parts[1] || null;
        return null;
    }
}

export const rollTableStore = new RollTableStore();
