import { EventEmitter } from 'node:events';
import {
    DOCUMENT_VISIBILITY,
    type DocumentAccessSubject,
    type DocumentOwnershipMap,
    type ResolvedDocumentOwnershipLevel,
} from './ownership';

// Foundry's full primary-document set. New types extend this union as their
// subsystems land. Stub types (Scene / FogExploration / Adventure / Setting)
// are listed so the registry surface is uniform even when not yet wired.
export type PrimaryDocumentType =
    | 'Actor'
    | 'Adventure'
    | 'Cards'
    | 'ChatMessage'
    | 'Combat'
    | 'FogExploration'
    | 'Folder'
    | 'Item'
    | 'JournalEntry'
    | 'Macro'
    | 'Playlist'
    | 'RollTable'
    | 'Scene'
    | 'Setting'
    | 'User';

export type ModifyDocumentAction = 'get' | 'create' | 'update' | 'delete';
export type ChangeAction = Exclude<ModifyDocumentAction, 'get'>;

export interface DocumentLike {
    id?: string;
    _id?: string;
}

/**
 * Per-document change event. Emitted from a Store when an apply produced an
 * observable state change (no-op applies emit nothing). See ADR-0012.
 */
export interface DocumentChangedEvent {
    type: PrimaryDocumentType;
    id: string;
    action: ChangeAction;
}

/**
 * List-level invalidation event. Emitted when the user-visible set changes —
 * ownership crossings, creates, deletes. Distinct from per-document changes:
 * clients add/remove from a list rather than patch one.
 */
export interface DocumentListInvalidatedEvent {
    type: PrimaryDocumentType;
    reason: string;
    documentId?: string;
    targetUserIds?: string[];
}

// Store reads return defensive clones so adapters/routes cannot mutate cache state by accident.
export function cloneDocument<TDocument>(document: TDocument): TDocument {
    return structuredClone(document);
}

export function getDocumentId(document: DocumentLike | null | undefined): string | null {
    return document?._id || document?.id || null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge with Foundry-style dotted-key support ("system.hp.value": 5).
 * Mutates target in place; returns it for convenience.
 */
export function deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
): Record<string, unknown> {
    for (const [key, value] of Object.entries(source)) {
        if (key.includes('.')) {
            const parts = key.split('.');
            let current = target;
            for (let i = 0; i < parts.length - 1; i += 1) {
                const part = parts[i];
                if (!isRecord(current[part])) current[part] = {};
                current = current[part] as Record<string, unknown>;
            }
            current[parts[parts.length - 1]] = value;
            continue;
        }
        if (isRecord(value) && isRecord(target[key])) {
            deepMerge(target[key] as Record<string, unknown>, value);
        } else {
            target[key] = value;
        }
    }
    return target;
}

/**
 * Stable JSON used only for observable-change detection on event emission.
 * Not for serialization; sibling-property order matters here.
 */
export function stableJson(value: unknown): string {
    return JSON.stringify(value);
}

export function toDocumentArray<TDocument extends DocumentLike>(result: unknown): TDocument[] {
    if (!result) return [];
    if (Array.isArray(result)) return result.filter(isRecord) as unknown as TDocument[];
    if (isRecord(result)) return [result as unknown as TDocument];
    return [];
}

export function getOperationIds<TDocument extends DocumentLike>(
    operation: Record<string, unknown> | undefined,
    docs: TDocument[],
): string[] {
    if (Array.isArray(operation?.ids)) {
        return operation.ids.filter((id): id is string => typeof id === 'string');
    }
    return docs.map(getDocumentId).filter((id): id is string => Boolean(id));
}

/**
 * Append created embedded children to an array **idempotently by `_id`** (ADR-0012).
 *
 * A Sheet-Delver-initiated write applies the same create twice — once when the Repository
 * mirrors the Foundry result, once when the broadcast lands. Embedded-array creates that
 * `push` unconditionally turn one added child into two rows. Children already present (by id)
 * are skipped; children with no id are appended (no key to dedupe on). Every embedded
 * create path (items/effects/combatants/cards/sounds/pages/results) routes through here so
 * the idempotency contract can't drift per store.
 */
export function appendCreatedById<TDocument extends DocumentLike>(
    existing: TDocument[] | undefined,
    created: TDocument[],
): TDocument[] {
    const next = [...(existing || [])];
    for (const doc of created) {
        const id = getDocumentId(doc);
        if (id && next.some(item => getDocumentId(item) === id)) continue;
        next.push(cloneDocument(doc));
    }
    return next;
}

/**
 * Abstract base for every Foundry primary-document Store.
 *
 * Subclasses implement `resolveOwnership` (the policy hook per ADR-0013).
 * Embedded children are handled by overriding `applyEmbeddedChange`.
 *
 * Firing rules (per ADR-0012):
 *   1. Emit only on observable state change.
 *   2. No emission during seeding (events fire only after isReady() === true).
 *   3. List-invalidation is a separate event from per-document changes.
 */
export abstract class PrimaryDocumentStore<TDocument extends DocumentLike> extends EventEmitter {
    public abstract readonly documentType: PrimaryDocumentType;

    protected documents = new Map<string, TDocument>();
    protected ready = false;
    protected staleDocumentIds = new Set<string>();

    /**
     * Per-type ownership resolver. Subclasses encode the type's visibility
     * policy (standard ownership map, whisper-based, derived from children, etc.).
     */
    protected abstract resolveOwnership(
        document: TDocument,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel;

    /**
     * Subclass hook for embedded-document mutations. Called when
     * applyModifyDocument receives a `type` that isn't this Store's
     * own documentType (e.g., 'Item' / 'ActiveEffect' on ActorStore).
     * Default: ignore (most types have no embedded children).
     */
    protected applyEmbeddedChange(
        _type: string,
        _action: ModifyDocumentAction,
        _result: unknown,
        _operation?: Record<string, unknown>,
    ): void {
        // override in subclasses with embedded children
    }

    public async seed(loader: () => Promise<TDocument[]>): Promise<void> {
        // Bootstrap replaces the entire world snapshot; runtime events patch it afterward.
        // No events fire during seed (this.ready stays false until after the load completes).
        const docs = await loader();
        this.documents.clear();
        for (const doc of docs) {
            const id = getDocumentId(doc);
            if (id) this.documents.set(id, cloneDocument(doc));
        }
        this.staleDocumentIds.clear();
        this.ready = true;
    }

    public clear(_reason?: string): void {
        this.documents.clear();
        this.staleDocumentIds.clear();
        this.ready = false;
    }

    public isReady(): boolean {
        return this.ready;
    }

    /**
     * Privileged list — no ownership filter. Used internally by subsystems
     * and bootstrap paths. Route-facing callers should use the subject-scoped form.
     */
    public list(): TDocument[];
    public list(options: {
        subject: DocumentAccessSubject;
        minOwnership?: ResolvedDocumentOwnershipLevel;
    }): TDocument[];
    public list(options?: {
        subject?: DocumentAccessSubject;
        minOwnership?: ResolvedDocumentOwnershipLevel;
    }): TDocument[] {
        const all = Array.from(this.documents.values());
        const subject = options?.subject;
        if (!subject) return all.map(cloneDocument);
        const threshold = options?.minOwnership ?? DOCUMENT_VISIBILITY.LIST_VISIBLE;
        return all
            .filter(doc => this.resolveOwnership(doc, subject) >= threshold)
            .map(cloneDocument);
    }

    /**
     * Privileged get — no ownership filter. Route-facing callers should use
     * the subject-scoped form which returns null when access is denied.
     */
    public get(documentId: string): TDocument | null;
    public get(
        documentId: string,
        options: {
            subject: DocumentAccessSubject;
            minOwnership?: ResolvedDocumentOwnershipLevel;
        },
    ): TDocument | null;
    public get(
        documentId: string,
        options?: {
            subject?: DocumentAccessSubject;
            minOwnership?: ResolvedDocumentOwnershipLevel;
        },
    ): TDocument | null {
        const doc = this.documents.get(documentId);
        if (!doc) return null;
        const subject = options?.subject;
        if (!subject) return cloneDocument(doc);
        const threshold = options?.minOwnership ?? DOCUMENT_VISIBILITY.DETAIL_VISIBLE;
        if (this.resolveOwnership(doc, subject) < threshold) return null;
        return cloneDocument(doc);
    }

    /**
     * Ownership predicate — returns false for missing docs as well as denied access.
     */
    public canReadDocument(
        documentId: string,
        subject: DocumentAccessSubject,
        minOwnership: ResolvedDocumentOwnershipLevel = DOCUMENT_VISIBILITY.DETAIL_VISIBLE,
    ): boolean {
        const doc = this.documents.get(documentId);
        if (!doc) return false;
        return this.resolveOwnership(doc, subject) >= minOwnership;
    }

    public upsert(document: TDocument): void {
        const id = getDocumentId(document);
        if (!id) return;
        const existing = this.documents.get(id);
        const beforeJson = existing ? stableJson(existing) : null;
        const action: ChangeAction = existing ? 'update' : 'create';
        const beforeOwnership = existing ? (existing as { ownership?: DocumentOwnershipMap }).ownership : undefined;
        this.documents.set(id, cloneDocument(document));
        const afterJson = stableJson(this.documents.get(id));
        if (afterJson !== beforeJson) this.emitChanged(id, action);
        const afterOwnership = (document as { ownership?: DocumentOwnershipMap }).ownership;
        this.diffOwnershipAndEmitInvalidation(id, action, beforeOwnership, afterOwnership);
    }

    public patch(documentId: string, diff: Record<string, unknown>): void {
        const existing = this.documents.get(documentId);
        if (!existing) {
            this.markStale(documentId, 'patch-miss');
            return;
        }
        const before = stableJson(existing);
        const beforeOwnership = (existing as { ownership?: DocumentOwnershipMap }).ownership
            ? structuredClone((existing as { ownership?: DocumentOwnershipMap }).ownership)
            : undefined;
        deepMerge(existing as Record<string, unknown>, diff);
        this.documents.set(documentId, existing);
        if (stableJson(existing) !== before) {
            this.emitChanged(documentId, 'update');
            this.diffOwnershipAndEmitInvalidation(
                documentId,
                'update',
                beforeOwnership,
                (existing as { ownership?: DocumentOwnershipMap }).ownership,
            );
        }
    }

    public delete(documentId: string): void {
        const existing = this.documents.get(documentId);
        const existed = this.documents.delete(documentId);
        this.staleDocumentIds.delete(documentId);
        if (existed) {
            this.emitChanged(documentId, 'delete');
            // Delete removes the doc for everyone who could see it. Emit
            // broadcast-wide listInvalidated (no targetUserIds).
            const ownership = existing
                ? (existing as { ownership?: DocumentOwnershipMap }).ownership
                : undefined;
            this.emitListInvalidated('delete', {
                documentId,
                targetUserIds: this.usersWithEffectiveVisibility(ownership),
            });
        }
    }

    public markStale(documentId?: string, _reason?: string): void {
        if (documentId) this.staleDocumentIds.add(documentId);
        else this.ready = false;
    }

    /**
     * Entry point for inbound modifyDocument events. Routes by document type:
     * if the type matches this Store's own type, apply directly; otherwise
     * delegate to the subclass embedded handler (for types like Item/ActiveEffect
     * on ActorStore).
     */
    public applyModifyDocument(
        type: string,
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        if (type === this.documentType) {
            this.applySelfChange(action, result, operation);
        } else {
            this.applyEmbeddedChange(type, action, result, operation);
        }
    }

    protected applySelfChange(
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        const docs = toDocumentArray<TDocument>(result);

        if (action === 'delete') {
            const ids = getOperationIds(operation, docs);
            for (const id of ids) {
                const doc = this.documents.get(id);
                const existed = this.documents.delete(id);
                this.staleDocumentIds.delete(id);
                if (existed) {
                    this.emitChanged(id, 'delete');
                    const ownership = doc
                        ? (doc as { ownership?: DocumentOwnershipMap }).ownership
                        : undefined;
                    this.emitListInvalidated('delete', {
                        documentId: id,
                        targetUserIds: this.usersWithEffectiveVisibility(ownership),
                    });
                }
            }
            return;
        }

        for (const doc of docs) {
            const id = getDocumentId(doc);
            if (!id) continue;
            const existing = this.documents.get(id);

            if (existing && action === 'update') {
                const before = stableJson(existing);
                const beforeOwnership = (existing as { ownership?: DocumentOwnershipMap }).ownership
                    ? structuredClone((existing as { ownership?: DocumentOwnershipMap }).ownership)
                    : undefined;
                deepMerge(existing as Record<string, unknown>, doc as Record<string, unknown>);
                this.documents.set(id, existing);
                if (stableJson(existing) !== before) {
                    this.emitChanged(id, 'update');
                    this.diffOwnershipAndEmitInvalidation(
                        id,
                        'update',
                        beforeOwnership,
                        (existing as { ownership?: DocumentOwnershipMap }).ownership,
                    );
                }
            } else if (action === 'update') {
                // Partial update without a cached base is unsafe to apply blindly.
                this.markStale(id, `${this.documentType}-update-miss`);
            } else if (action === 'create') {
                const before = existing ? stableJson(existing) : null;
                this.documents.set(id, cloneDocument(doc));
                if (stableJson(doc) !== before) {
                    this.emitChanged(id, 'create');
                    const ownership = (doc as { ownership?: DocumentOwnershipMap }).ownership;
                    this.emitListInvalidated('create', {
                        documentId: id,
                        targetUserIds: this.usersWithEffectiveVisibility(ownership),
                    });
                }
            } else {
                // action === 'get': silent upsert (bootstrap or refresh fetch).
                this.documents.set(id, cloneDocument(doc));
            }
        }
    }

    /**
     * Emit a per-document change event. Idempotent across the two-path apply
     * (Repository mirror + broadcast) because callers gate on observable change.
     * Silent during seeding (ready === false).
     */
    protected emitChanged(documentId: string, action: ChangeAction): void {
        if (!this.ready) return;
        const event: DocumentChangedEvent = { type: this.documentType, id: documentId, action };
        this.emit('documentChanged', event);
        this.emit('primaryDocumentChanged', event);
    }

    /**
     * Emit a list-level invalidation event. Used for ownership transitions,
     * creates, and deletes. Silent during seeding.
     */
    protected emitListInvalidated(
        reason: string,
        options?: { documentId?: string; targetUserIds?: string[] },
    ): void {
        if (!this.ready) return;
        const event: DocumentListInvalidatedEvent = {
            type: this.documentType,
            reason,
            documentId: options?.documentId,
            targetUserIds: options?.targetUserIds,
        };
        this.emit('documentListInvalidated', event);
        this.emit('primaryDocumentListInvalidated', event);
    }

    /**
     * Compute the set of user ids whose effective LIST_VISIBLE access on the
     * given ownership map crosses the threshold. Used to scope listInvalidated
     * events to affected users on create/delete.
     */
    protected usersWithEffectiveVisibility(
        ownership: DocumentOwnershipMap | undefined,
    ): string[] | undefined {
        if (!ownership) return undefined;
        const defaultLevel = ownership.default ?? 0;
        const visibleByDefault = defaultLevel >= DOCUMENT_VISIBILITY.LIST_VISIBLE;
        // If world-default already exposes the doc, the change is broadcast-wide.
        if (visibleByDefault) return undefined;
        // Otherwise, scope to users with explicit ownership at or above the threshold.
        const userIds: string[] = [];
        for (const [key, level] of Object.entries(ownership)) {
            if (key === 'default') continue;
            if ((level ?? 0) >= DOCUMENT_VISIBILITY.LIST_VISIBLE) userIds.push(key);
        }
        return userIds.length > 0 ? userIds : undefined;
    }

    /**
     * Diff an old/new ownership map and emit a listInvalidated targeted at the
     * users whose effective LIST_VISIBLE access changed. Called after upsert/patch.
     */
    protected diffOwnershipAndEmitInvalidation(
        documentId: string,
        _action: ChangeAction,
        beforeOwnership: DocumentOwnershipMap | undefined,
        afterOwnership: DocumentOwnershipMap | undefined,
    ): void {
        if (!beforeOwnership && !afterOwnership) return;
        const before = beforeOwnership ?? {};
        const after = afterOwnership ?? {};

        const beforeDefault = before.default ?? 0;
        const afterDefault = after.default ?? 0;
        const beforeVisibleByDefault = beforeDefault >= DOCUMENT_VISIBILITY.LIST_VISIBLE;
        const afterVisibleByDefault = afterDefault >= DOCUMENT_VISIBILITY.LIST_VISIBLE;

        // Default-level visibility crossing affects everyone — emit broadcast-wide.
        if (beforeVisibleByDefault !== afterVisibleByDefault) {
            this.emitListInvalidated('ownership-default-changed', { documentId });
            return;
        }

        // Per-user crossings. A user's effective level is their explicit entry
        // when present, otherwise the default. Compute pre/post for every user id
        // mentioned in either map.
        const affectedUserIds = new Set<string>();
        for (const key of Object.keys(before)) {
            if (key !== 'default') affectedUserIds.add(key);
        }
        for (const key of Object.keys(after)) {
            if (key !== 'default') affectedUserIds.add(key);
        }

        const crossed: string[] = [];
        for (const userId of affectedUserIds) {
            const beforeLevel = before[userId] ?? beforeDefault;
            const afterLevel = after[userId] ?? afterDefault;
            const beforeVisible = beforeLevel >= DOCUMENT_VISIBILITY.LIST_VISIBLE;
            const afterVisible = afterLevel >= DOCUMENT_VISIBILITY.LIST_VISIBLE;
            if (beforeVisible !== afterVisible) crossed.push(userId);
        }

        if (crossed.length > 0) {
            this.emitListInvalidated('ownership-user-changed', {
                documentId,
                targetUserIds: crossed,
            });
        }
    }
}
