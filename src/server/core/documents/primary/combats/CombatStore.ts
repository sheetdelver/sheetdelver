import type { CombatDocument, CombatantGroupDocument } from '@server/shared/types/documents';
import {
    applyEmbeddedCollectionChange,
    getDocumentId,
    PrimaryDocumentStore,
    stableJson,
    toDocumentArray,
    type DocumentChangedEvent,
    type DocumentListInvalidatedEvent,
    type ModifyDocumentAction,
    type PrimaryDocumentType,
} from '../base/PrimaryDocumentStore';
import { unionDocumentAudiences } from '../base/audience';
import {
    DOCUMENT_VISIBILITY,
    DocumentOwnershipLevel,
    isGM,
    type DocumentAccessSubject,
    type ResolvedDocumentOwnershipLevel,
} from '../base/ownership';
import type { ActorStore } from '../actors/ActorStore';

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
 * Embedded children: `Combatant` and `CombatantGroup` arrive with
 * `parentUuid: Combat.<id>`. The parent combat's `combatants[]` / `groups[]`
 * array is mutated in place. Changes to the non-hidden combatant actor-id
 * source set emit a list invalidation because they can add or remove combat
 * visibility for non-GM subjects. Direct parent Combat updates that replace
 * `combatants` wholesale are diffed the same way (ADR-0028 Phase 2).
 *
 * Cross-store dependency: CombatStore consumes ActorStore for visibility
 * resolution and for projected tracker rows (actor name/img/system data flow
 * into the combat REST projection). The dependency is declared explicitly via
 * {@link bindActorVisibilityBridge}: the coordinator wires it at module-init
 * alongside the standard Store registrations. CombatStore subscribes to
 * `actorStore.documentListInvalidated` to re-emit its own list invalidation
 * for combats containing the affected actor, and to
 * `actorStore.documentChanged` to re-emit a combat `update` change so
 * already-open trackers refetch rows whose actor display data changed.
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
        // Tests and lifecycle bootstrap may both request the same wiring. Keep
        // the bridge idempotent so repeated initialization cannot duplicate events.
        if (this.actorStore === actorStore) return;
        this.actorStore = actorStore;
        actorStore.on('documentListInvalidated', (event: DocumentListInvalidatedEvent) => {
            if (!event.documentId) return;
            const affected = this.findCombatsContainingActor(event.documentId);
            if (affected.length === 0) return;
            for (const combatId of affected) {
                this.emitListInvalidated('actor-visibility-changed', {
                    documentId: combatId,
                    audience: event.audience,
                });
            }
        });
        // Actor document changes (name/img/system) feed projected tracker rows,
        // so an ordinary actor update must refresh combats that contain the
        // actor even though the Combat document itself did not change. This is
        // a declared projection-dependency invalidation: the gateway's normal
        // combat visibility gating decides which clients receive it, which
        // also covers players who can see the combat but cannot read the actor
        // (ADR-0028 Phase 2). Creates and deletes already cross through the
        // actor list-invalidation bridge above.
        actorStore.on('documentChanged', (event: DocumentChangedEvent) => {
            if (event.action !== 'update') return;
            const affected = this.findCombatsContainingActor(event.id);
            for (const combatId of affected) {
                this.emitChanged(combatId, 'update');
            }
        });
    }

    /**
     * Declare and wire CombatStore's SceneStore dependency (ADR-0028 Phase 7).
     * Token documents feed combatant display identity and unlinked-token
     * defeated state, so a scene change (embedded Token/ActorDelta mutations
     * emit an `update` on the parent scene) must refresh combats whose
     * combatants sit on that scene. Scene deletes flow the same way — the
     * identity falls back to the base actor on rebuild.
     */
    public bindSceneBridge(sceneStore: PrimaryDocumentStore<{ _id?: string; id?: string }>): void {
        sceneStore.on('documentChanged', (event: DocumentChangedEvent) => {
            const affected = this.findCombatsOnScene(event.id);
            for (const combatId of affected) {
                this.emitChanged(combatId, 'update');
            }
        });
    }

    /**
     * Return the ids of combats that contain a combatant on the given scene.
     * Combatants carry `sceneId`; the parent combat's own `scene` field also
     * counts so scene-linked encounters refresh even before combatants land.
     */
    public findCombatsOnScene(sceneId: string): string[] {
        const ids: string[] = [];
        for (const combat of this.documents.values()) {
            const matches = combat.scene === sceneId
                || (combat.combatants || []).some(c => c.sceneId === sceneId);
            if (matches) {
                const id = getDocumentId(combat);
                if (id) ids.push(id);
            }
        }
        return ids;
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
     * routes here; `Combatant` mutations apply to the parent combat's
     * `combatants[]` array and `CombatantGroup` mutations to `groups[]`, each
     * emitting a `combatChanged` (update) on the parent.
     */
    protected applyEmbeddedChange(
        type: string,
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        if (type !== 'Combatant' && type !== 'CombatantGroup') return;
        const combatId = this.getCombatIdFromOperation(operation);
        if (!combatId) return;
        const combat = this.documents.get(combatId);
        if (!combat) return;

        const before = stableJson(combat);
        const beforeAudience = this.audienceForDocument(combat);
        const beforeVisibilitySource = combatVisibilitySourceState(combat);

        if (type === 'Combatant') {
            combat.combatants = applyEmbeddedCollectionChange(combat.combatants, action, result, operation);
        } else {
            combat.groups = applyEmbeddedCollectionChange<CombatantGroupDocument>(combat.groups, action, result, operation);
        }

        this.documents.set(combatId, combat);
        if (action !== 'get' && stableJson(combat) !== before) {
            const changedAudience = unionDocumentAudiences(
                beforeAudience,
                this.audienceForDocument(combat),
            );
            this.emitChanged(combatId, 'update', changedAudience);
            if (combatVisibilitySourceState(combat) !== beforeVisibilitySource) {
                this.emitListInvalidated('combatant-visibility-changed', {
                    documentId: combatId,
                    audience: changedAudience,
                });
            }
        }
    }

    /**
     * Direct parent Combat updates can replace `combatants` (or `groups`)
     * wholesale — Foundry performs such updates for combatant state — which
     * changes derived visibility without touching an ownership map, so the
     * generic base diffing never fires. Diff the visibility source across the
     * base apply and emit a list invalidation on change so former viewers
     * drop the combat and new viewers pick it up (ADR-0028 Phase 2).
     */
    protected applySelfChange(
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        const beforeSources = new Map<string, string>();
        const beforeAudiences = new Map<string, ReturnType<CombatStore['audienceForDocument']>>();
        if (action === 'update') {
            for (const doc of toDocumentArray<CombatDocument>(result)) {
                const id = getDocumentId(doc);
                if (!id) continue;
                const existing = this.documents.get(id);
                if (existing) {
                    beforeSources.set(id, combatVisibilitySourceState(existing));
                    beforeAudiences.set(id, this.audienceForDocument(existing));
                }
            }
        }

        super.applySelfChange(action, result, operation);

        for (const [id, beforeSource] of beforeSources) {
            const updated = this.documents.get(id);
            if (!updated) continue;
            if (combatVisibilitySourceState(updated) !== beforeSource) {
                this.emitListInvalidated('combat-visibility-source-changed', {
                    documentId: id,
                    audience: unionDocumentAudiences(
                        beforeAudiences.get(id) ?? this.audienceForDocument(updated),
                        this.audienceForDocument(updated),
                    ),
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
