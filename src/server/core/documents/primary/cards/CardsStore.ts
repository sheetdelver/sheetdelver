import type { CardsDocument, CardDocument } from '@server/shared/types/documents';
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

function cardId(card: unknown): string | null {
    if (!isRecord(card)) return null;
    return getDocumentId(card);
}

/**
 * Cards primary-document Store. Full hydration + bootstrap seed.
 *
 * Visibility (per ADR-0013): standard `ownership` map — GMs short-circuit to
 * OWNER via `getEffectiveOwnership`; non-GM subjects read explicit user entry
 * or fall back to `ownership.default`.
 *
 * Embedded children: `Card` events with `parentUuid: Cards.<id>` apply to the
 * parent's `cards[]` array in place. No game-specific card semantics modeled
 * (Sheet Delver doesn't use cards today). Cross-Cards-doc transfers
 * (`Cards#pass` deck→hand→pile) arrive as paired update/delete events across
 * two parents; each leg is handled independently by its parent's handler so
 * both deck and hand caches stay coherent on change.
 */
export class CardsStore extends PrimaryDocumentStore<CardsDocument> {
    public readonly documentType: PrimaryDocumentType = 'Cards';

    protected resolveOwnership(
        cards: CardsDocument,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        const ownership = cards.ownership as DocumentOwnershipMap | undefined;
        return getEffectiveOwnership(ownership, subject);
    }

    public listByFolderIds(folderIds: Iterable<string | null>, options?: {
        subject?: DocumentAccessSubject;
        minOwnership?: ResolvedDocumentOwnershipLevel;
    }): CardsDocument[] {
        const ids = new Set<string | null>();
        for (const id of folderIds) ids.add(id);

        const filterByFolder = (allCards: CardsDocument[]) =>
            allCards.filter(c => ids.has((c.folder as string | null) ?? null));

        if (options?.subject) {
            const subject = options.subject;
            const threshold = options.minOwnership ?? DocumentOwnershipLevel.LIMITED;
            return filterByFolder(this.list({ subject, minOwnership: threshold }));
        }
        return filterByFolder(this.list());
    }

    /**
     * Embedded handler for `Card` events under Cards docs. Foundry dispatches
     * these with `parentUuid: Cards.<id>`; the parent's `cards[]` array is
     * mutated in place and a `documentChanged` (update) fires on the parent.
     */
    protected applyEmbeddedChange(
        type: string,
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        if (type !== 'Card') return;
        const parentId = this.getCardsIdFromOperation(operation);
        if (!parentId) return;
        const parent = this.documents.get(parentId);
        if (!parent) return;

        const before = stableJson(parent);
        const docs = toDocumentArray<Record<string, unknown>>(result);
        const cards = [...(parent.cards || [])];

        if (action === 'delete') {
            const ids = getOperationIds(operation, docs);
            parent.cards = cards.filter(c => {
                const id = cardId(c);
                return !id || !ids.includes(id);
            }) as CardDocument[];
        } else if (action === 'update') {
            for (const incoming of docs) {
                const id = getDocumentId(incoming);
                if (!id) continue;
                const index = cards.findIndex(existing => isRecord(existing) && getDocumentId(existing) === id);
                if (index >= 0 && isRecord(cards[index])) {
                    deepMerge(cards[index] as Record<string, unknown>, incoming);
                }
            }
            parent.cards = cards as CardDocument[];
        } else if (action === 'create') {
            parent.cards = [...cards, ...docs.map(c => cloneDocument(c))] as CardDocument[];
        }

        this.documents.set(parentId, parent);
        if (action !== 'get' && stableJson(parent) !== before) {
            this.emitChanged(parentId, 'update');
        }
    }

    private getCardsIdFromOperation(operation?: Record<string, unknown>): string | null {
        if (typeof operation?.parentId === 'string') return operation.parentId;
        if (typeof operation?.parentUuid !== 'string') return null;
        const parts = operation.parentUuid.split('.');
        if (parts[0] === 'Cards') return parts[1] || null;
        return null;
    }
}

export const cardsStore = new CardsStore();
