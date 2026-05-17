import type { RawItem } from '@server/shared/types/actors';
import {
    cloneDocument,
    deepMerge,
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
    getEffectiveOwnership,
    type DocumentAccessSubject,
    type DocumentOwnershipMap,
    type ResolvedDocumentOwnershipLevel,
} from '../base/ownership';

function effectId(effect: unknown): string | null {
    if (!isRecord(effect)) return null;
    return getDocumentId(effect);
}

/**
 * World Item primary-document Store. Full hydration + bootstrap seed.
 *
 * Visibility (per ADR-0013): standard `ownership` map — GMs short-circuit to
 * OWNER via `getEffectiveOwnership`; non-GM subjects read explicit user entry
 * or fall back to `ownership.default`. Same policy as Actor and JournalEntry.
 *
 * Embedded children: `ActiveEffect` events with `parentUuid: Item.<id>` apply
 * to the parent item's `effects[]` array. Actor-owned items continue to flow
 * through `ActorStore` via `parentUuid: Actor.<id>.Item.<id>` — those are not
 * Foundry world-Item events and never reach this Store thanks to the router's
 * parentUuid-first priority (ADR-0011 Phase 6).
 *
 * Folder integration: items carry their own `folder` id at the document level;
 * `listByFolderIds` is provided for future folder-organized projections that
 * join `item.folder` against `FolderStore`. Phase 6 does not consume it (no
 * Sheet Delver UI for world items today) but the helper lands for parity with
 * `JournalStore.listByFolderIds`.
 */
export class ItemStore extends PrimaryDocumentStore<RawItem> {
    public readonly documentType: PrimaryDocumentType = 'Item';

    protected resolveOwnership(
        item: RawItem,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        const ownership = item.ownership as DocumentOwnershipMap | undefined;
        return getEffectiveOwnership(ownership, subject);
    }

    /**
     * Return items whose `folder` id is in the provided set. Mirrors
     * `JournalStore.listByFolderIds` so future folder-organized item views
     * can join `item.folder` against `FolderStore` without re-implementing
     * the lookup.
     */
    public listByFolderIds(folderIds: Iterable<string | null>, options?: {
        subject?: DocumentAccessSubject;
        minOwnership?: ResolvedDocumentOwnershipLevel;
    }): RawItem[] {
        const ids = new Set<string | null>();
        for (const id of folderIds) ids.add(id);

        const filterByFolder = (items: RawItem[]) =>
            items.filter(item => ids.has((item.folder as string | null) ?? null));

        if (options?.subject) {
            const subject = options.subject;
            const threshold = options.minOwnership ?? DocumentOwnershipLevel.LIMITED;
            return filterByFolder(this.list({ subject, minOwnership: threshold }));
        }
        return filterByFolder(this.list());
    }

    /**
     * Embedded handler for `ActiveEffect` events under world Items. Foundry
     * dispatches these with `parentUuid: Item.<id>`; the parent item's
     * `effects[]` array is mutated in place and a `documentChanged` (update)
     * fires on the parent so fan-out subscribers refresh.
     */
    protected applyEmbeddedChange(
        type: string,
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        if (type !== 'ActiveEffect') return;
        const itemId = this.getItemIdFromOperation(operation);
        if (!itemId) return;
        const item = this.documents.get(itemId);
        if (!item) return;

        const before = stableJson(item);
        const docs = toDocumentArray<Record<string, unknown>>(result);
        const effects = [...(item.effects || [])];

        if (action === 'delete') {
            const ids = getOperationIds(operation, docs);
            item.effects = effects.filter(effect => {
                const id = effectId(effect);
                return !id || !ids.includes(id);
            });
        } else if (action === 'update') {
            for (const incoming of docs) {
                const id = getDocumentId(incoming);
                if (!id) continue;
                const index = effects.findIndex(existing => isRecord(existing) && getDocumentId(existing) === id);
                if (index >= 0 && isRecord(effects[index])) {
                    deepMerge(effects[index] as Record<string, unknown>, incoming);
                }
            }
            item.effects = effects;
        } else if (action === 'create') {
            item.effects = [...effects, ...docs.map(e => cloneDocument(e))];
        }

        this.documents.set(itemId, item);
        if (action !== 'get' && stableJson(item) !== before) {
            this.emitChanged(itemId, 'update');
        }
    }

    private getItemIdFromOperation(operation?: Record<string, unknown>): string | null {
        if (typeof operation?.parentId === 'string') return operation.parentId;
        if (typeof operation?.parentUuid !== 'string') return null;
        const parts = operation.parentUuid.split('.');
        if (parts[0] === 'Item') return parts[1] || null;
        return null;
    }
}

export const itemStore = new ItemStore();
