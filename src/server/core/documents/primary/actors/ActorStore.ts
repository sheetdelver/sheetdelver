import type { ActorDocument, ItemDocument } from '@server/shared/types/actors';
import {
    cloneDocument,
    deepMerge,
    getDocumentId,
    getOperationIds,
    isRecord,
    PrimaryDocumentStore,
    stableJson,
    toDocumentArray,
    type ChangeAction,
    type DocumentChangedEvent,
    type DocumentListInvalidatedEvent,
    type ModifyDocumentAction,
    type PrimaryDocumentType,
} from '../base/PrimaryDocumentStore';
import {
    getEffectiveOwnership,
    type DocumentAccessSubject,
    type DocumentOwnershipMap,
    type ResolvedDocumentOwnershipLevel,
} from '../base/ownership';

/**
 * Discriminated-union event payload re-emitted alongside the base
 * documentChanged / documentListInvalidated events so any existing subscribers
 * (e.g., SystemService's actorChanged bridge) keep working unchanged.
 */
export type ActorStoreEvent =
    | { type: 'actorChanged'; actorId: string; action: ChangeAction }
    | { type: 'actorListInvalidated'; reason: string; actorId?: string; targetUserIds?: string[] };

type ActorStoreListener = (event: ActorStoreEvent) => void;

/**
 * Actor primary-document Store. Full hydration + bootstrap seed. Ownership map
 * is the standard Foundry `{ default, userId }` shape; embedded Item and
 * ActiveEffect mutations are routed here from the broadcast router and applied
 * to the appropriate parent actor.
 *
 * Round 01 API surface (`listActors`, `getActor`, `canReadActor`, `onActorStoreEvent`)
 * is preserved as thin wrappers over the base — callers don't migrate.
 */
export class ActorStore extends PrimaryDocumentStore<ActorDocument> {
    public readonly documentType: PrimaryDocumentType = 'Actor';

    protected resolveOwnership(
        actor: ActorDocument,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        const ownership = actor.ownership as DocumentOwnershipMap | undefined;
        return getEffectiveOwnership(ownership, subject);
    }

    // ---------------------------------------------------------------------
    // Round 01 backwards-compat surface — thin wrappers over the base.
    // ---------------------------------------------------------------------

    public listActors(options: {
        subject: DocumentAccessSubject;
        minOwnership?: ResolvedDocumentOwnershipLevel;
    }): ActorDocument[] {
        return this.list(options);
    }

    public getActor(
        actorId: string,
        options: {
            subject: DocumentAccessSubject;
            minOwnership?: ResolvedDocumentOwnershipLevel;
        },
    ): ActorDocument | null {
        return this.get(actorId, options);
    }

    public canReadActor(
        actorId: string,
        subject: DocumentAccessSubject,
        minOwnership?: ResolvedDocumentOwnershipLevel,
    ): boolean {
        return this.canReadDocument(actorId, subject, minOwnership);
    }

    public onActorStoreEvent(listener: ActorStoreListener): void {
        this.on('actorStoreEvent', listener);
    }

    public offActorStoreEvent(listener: ActorStoreListener): void {
        this.off('actorStoreEvent', listener);
    }

    // ---------------------------------------------------------------------
    // Subclass overrides for emit shaping and embedded children.
    // ---------------------------------------------------------------------

    protected emitChanged(actorId: string, action: ChangeAction): void {
        super.emitChanged(actorId, action);
        // Round 01 compatibility: re-emit on the discriminated-union event so
        // existing subscribers (SystemService.actorChanged bridge) keep working.
        this.emit('actorStoreEvent', { type: 'actorChanged', actorId, action } satisfies ActorStoreEvent);
    }

    protected emitListInvalidated(
        reason: string,
        options?: { documentId?: string; targetUserIds?: string[] },
    ): void {
        super.emitListInvalidated(reason, options);
        // Round 01 compatibility: bridge to actorListInvalidated discriminated union.
        this.emit('actorStoreEvent', {
            type: 'actorListInvalidated',
            reason,
            actorId: options?.documentId,
            targetUserIds: options?.targetUserIds,
        } satisfies ActorStoreEvent);
    }

    /**
     * Embedded children for Actor: Item (actor-owned items) and ActiveEffect
     * (on the actor or on actor-owned items via the Actor.<id>.Item.<id> parentUuid).
     */
    protected applyEmbeddedChange(
        type: string,
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        if (type === 'Item') {
            this.applyEmbeddedItemChangeFromResult(action, result, operation);
        } else if (type === 'ActiveEffect') {
            this.applyEmbeddedEffectChangeFromResult(action, result, operation);
        }
    }

    private applyEmbeddedItemChangeFromResult(
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        const actorId = this.getActorIdFromOperation(operation);
        if (!actorId) return;
        const actor = this.documents.get(actorId);
        if (!actor) return;
        const before = stableJson(actor);

        const docs = toDocumentArray<ItemDocument>(result);
        actor.items = actor.items || [];

        if (action === 'delete') {
            const ids = getOperationIds(operation, docs);
            actor.items = actor.items.filter(item => {
                const id = getDocumentId(item);
                return !id || !ids.includes(id);
            });
        } else if (action === 'update') {
            for (const item of docs) {
                const itemId = getDocumentId(item);
                const index = actor.items.findIndex(existing => getDocumentId(existing) === itemId);
                if (index >= 0) {
                    deepMerge(actor.items[index] as Record<string, unknown>, item as Record<string, unknown>);
                }
            }
        } else if (action === 'create') {
            // Idempotent create: the initiator-side mirror and the Foundry broadcast both
            // apply the same create (ADR-0012). Skip any doc already present by _id so the
            // second apply is a no-op instead of pushing a duplicate row.
            for (const item of docs) {
                const id = getDocumentId(item);
                if (id && actor.items.some(existing => getDocumentId(existing) === id)) continue;
                actor.items.push(cloneDocument(item));
            }
        }

        this.documents.set(actorId, actor);
        if (action !== 'get' && stableJson(actor) !== before) this.emitChanged(actorId, 'update');
    }

    private applyEmbeddedEffectChangeFromResult(
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        const parentUuid = typeof operation?.parentUuid === 'string' ? operation.parentUuid : '';
        const parts = parentUuid.split('.');
        // ActorDelta / synthetic token actors are intentionally outside this cache.
        if (parts[0] !== 'Actor') return;

        const actorId = parts[1];
        const actor = this.documents.get(actorId);
        if (!actor) return;
        const before = stableJson(actor);

        if (parts.length >= 4 && parts[2] === 'Item') {
            const itemId = parts[3];
            const item = actor.items?.find(existing => getDocumentId(existing) === itemId);
            if (!item) return;
            item.effects = this.applyEffectArray(item.effects, action, result, operation);
        } else {
            const actorRecord = actor as ActorDocument & { effects?: unknown[] };
            actorRecord.effects = this.applyEffectArray(actorRecord.effects, action, result, operation);
        }

        this.documents.set(actorId, actor);
        if (action !== 'get' && stableJson(actor) !== before) this.emitChanged(actorId, 'update');
    }

    private applyEffectArray(
        current: unknown[] | undefined,
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): unknown[] {
        const effects = [...(current || [])];
        const docs = toDocumentArray<Record<string, unknown>>(result);

        if (action === 'delete') {
            const ids = getOperationIds(operation, docs);
            return effects.filter(effect => {
                const id = isRecord(effect) ? getDocumentId(effect) : null;
                return !id || !ids.includes(id);
            });
        }

        if (action === 'update') {
            for (const effect of docs) {
                const effectId = getDocumentId(effect);
                const index = effects.findIndex(existing => isRecord(existing) && getDocumentId(existing) === effectId);
                if (index >= 0 && isRecord(effects[index])) {
                    deepMerge(effects[index] as Record<string, unknown>, effect);
                }
            }
            return effects;
        }

        if (action === 'create') {
            // Idempotent create (see embedded Item create): skip effects already present by
            // _id so the mirror + broadcast double-apply doesn't duplicate a row.
            const next = [...effects];
            for (const effect of docs) {
                const id = getDocumentId(effect);
                if (id && next.some(existing => isRecord(existing) && getDocumentId(existing) === id)) continue;
                next.push(cloneDocument(effect));
            }
            return next;
        }

        return effects;
    }

    private getActorIdFromOperation(operation?: Record<string, unknown>): string | null {
        if (typeof operation?.parentId === 'string') return operation.parentId;
        if (typeof operation?.parentUuid !== 'string') return null;
        const parts = operation.parentUuid.split('.');
        if (parts[0] === 'Actor') return parts[1] || null;
        return null;
    }
}

export const actorStore = new ActorStore();

// Re-exports so unrelated modules don't need a cross-import dance.
export type { DocumentChangedEvent, DocumentListInvalidatedEvent } from '../base/PrimaryDocumentStore';
