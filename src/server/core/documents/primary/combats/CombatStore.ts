import type { CombatDocument, CombatantDocument } from '@server/shared/types/documents';
import {
    cloneDocument,
    deepMerge,
    getDocumentId,
    getOperationIds,
    PrimaryDocumentStore,
    stableJson,
    toDocumentArray,
    type DocumentListInvalidatedEvent,
    type ModifyDocumentAction,
    type PrimaryDocumentType,
} from '../base/PrimaryDocumentStore';
import {
    DOCUMENT_VISIBILITY,
    DocumentOwnershipLevel,
    isGM,
    type DocumentAccessSubject,
    type ResolvedDocumentOwnershipLevel,
} from '../base/ownership';
import type { ActorStore } from '../actors/ActorStore';

function combatantId(combatant: CombatantDocument | null | undefined): string | null {
    return getDocumentId(combatant);
}

function combatVisibilitySourceState(combat: CombatDocument): string {
    const actorIds = new Set<string>();
    for (const combatant of combat.combatants || []) {
        if (combatant.hidden) continue;
        if (combatant.actorId) actorIds.add(combatant.actorId);
    }
    return stableJson(Array.from(actorIds).sort());
}

/**
 * Combat primary-document Store. Full hydration + bootstrap seed.
 *
 * Visibility (per ADR-0013, ADR-0011 Phase 5):
 *   - Combat documents carry no `ownership` map; visibility derives from
 *     contained combatants and their actors.
 *   - GMs are effective owners of every combat.
 *   - Non-GM subjects observe a combat iff it contains at least one non-hidden
 *     combatant whose `actorId` resolves to an actor the subject can read at
 *     `LIST_VISIBLE` via {@link ActorStore.canReadActor}.
 *   - Missing actors fail closed.
 *
 * Embedded children: `Combatant` arrives with `parentUuid: Combat.<id>`. The
     * parent combat's `combatants[]` array is mutated in place. Changes to the
     * non-hidden combatant actor-id source set emit a list invalidation because
     * they can add or remove combat visibility for non-GM subjects.
 *
 * Cross-store dependency: CombatStore consumes ActorStore for visibility
 * resolution. The dependency is declared explicitly via
 * {@link bindActorVisibilityBridge}: the coordinator wires it at module-init
 * alongside the standard Store registrations, and CombatStore subscribes to
     * `actorStore.documentListInvalidated` to re-emit its own list invalidation
     * for combats containing the affected actor.
 */
export class CombatStore extends PrimaryDocumentStore<CombatDocument> {
    public readonly documentType: PrimaryDocumentType = 'Combat';

    private actorStore: ActorStore | null = null;

    /**
     * Declare and wire CombatStore's ActorStore dependency. Stores the actor
     * reference for `resolveOwnership` lookups and subscribes to actor list
     * invalidations so combat visibility crossings propagate without polling.
     * Called once at module-init time by the coordinator.
     */
    public bindActorVisibilityBridge(actorStore: ActorStore): void {
        this.actorStore = actorStore;
        actorStore.on('documentListInvalidated', (event: DocumentListInvalidatedEvent) => {
            if (!event.documentId) return;
            const affected = this.findCombatsContainingActor(event.documentId);
            if (affected.length === 0) return;
            for (const combatId of affected) {
                this.emitListInvalidated('actor-visibility-changed', {
                    documentId: combatId,
                    targetUserIds: event.targetUserIds,
                });
            }
        });
    }

    /**
     * Return the ids of combats that contain a combatant whose `actorId` matches
     * the given actor. Used by the actor-visibility bridge to scope
     * `combatListInvalidated` to the combats whose subject set may have changed.
     */
    public findCombatsContainingActor(actorId: string): string[] {
        const ids: string[] = [];
        for (const combat of this.documents.values()) {
            if ((combat.combatants || []).some(c => c.actorId === actorId)) {
                const id = getDocumentId(combat);
                if (id) ids.push(id);
            }
        }
        return ids;
    }

    protected resolveOwnership(
        combat: CombatDocument,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        if (isGM(subject)) return DocumentOwnershipLevel.OWNER;

        // Without an ActorStore binding we can't cross-check; fail closed for non-GMs.
        if (!this.actorStore) return DocumentOwnershipLevel.NONE;

        const combatants = combat.combatants || [];
        for (const combatant of combatants) {
            if (combatant.hidden) continue;
            const actorId = combatant.actorId;
            if (!actorId) continue;
            if (this.actorStore.canReadActor(actorId, subject, DOCUMENT_VISIBILITY.LIST_VISIBLE)) {
                return DocumentOwnershipLevel.OBSERVER;
            }
        }
        return DocumentOwnershipLevel.NONE;
    }

    /**
     * Embedded JournalEntryPage parallel for Combat. `parentUuid: Combat.<id>`
     * routes here; mutations apply to the parent combat's `combatants[]` array
     * and emit a `combatChanged` (update) on the parent.
     */
    protected applyEmbeddedChange(
        type: string,
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        if (type !== 'Combatant') return;
        const combatId = this.getCombatIdFromOperation(operation);
        if (!combatId) return;
        const combat = this.documents.get(combatId);
        if (!combat) return;

        const before = stableJson(combat);
        const beforeVisibilitySource = combatVisibilitySourceState(combat);
        const docs = toDocumentArray<CombatantDocument>(result);
        combat.combatants = combat.combatants || [];

        if (action === 'delete') {
            const ids = getOperationIds(operation, docs);
            combat.combatants = combat.combatants.filter(c => {
                const id = combatantId(c);
                return !id || !ids.includes(id);
            });
        } else if (action === 'update') {
            for (const incoming of docs) {
                const id = combatantId(incoming);
                if (!id) continue;
                const index = combat.combatants.findIndex(existing => combatantId(existing) === id);
                if (index >= 0) {
                    deepMerge(combat.combatants[index] as Record<string, unknown>, incoming as Record<string, unknown>);
                }
            }
        } else if (action === 'create') {
            combat.combatants.push(...docs.map(c => cloneDocument(c)));
        }

        this.documents.set(combatId, combat);
        if (action !== 'get' && stableJson(combat) !== before) {
            this.emitChanged(combatId, 'update');
            if (combatVisibilitySourceState(combat) !== beforeVisibilitySource) {
                this.emitListInvalidated('combatant-visibility-changed', {
                    documentId: combatId,
                });
            }
        }
    }

    private getCombatIdFromOperation(operation?: Record<string, unknown>): string | null {
        if (typeof operation?.parentId === 'string') return operation.parentId;
        if (typeof operation?.parentUuid !== 'string') return null;
        const parts = operation.parentUuid.split('.');
        if (parts[0] === 'Combat') return parts[1] || null;
        return null;
    }
}

export const combatStore = new CombatStore();
