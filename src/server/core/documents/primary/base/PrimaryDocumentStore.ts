import { EventEmitter } from 'node:events';
import { logger } from '@shared/utils/logger';
import {
    DOCUMENT_VISIBILITY,
    type DocumentAccessSubject,
    type DocumentOwnershipMap,
    type ResolvedDocumentOwnershipLevel,
} from './ownership';
import {
    ALL_DOCUMENT_AUDIENCE,
    NO_DOCUMENT_AUDIENCE,
    documentAudienceForUsers,
    unionDocumentAudiences,
    type DocumentAudience,
} from './audience';

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
    audience: DocumentAudience;
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
    audience: DocumentAudience;
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

const FOUNDRY_OPERATOR_IDENTIFIER = '__$OPERATOR$__';

type FoundryFieldOperation =
    | { kind: 'delete' }
    | { kind: 'replace'; value: unknown }
    | { kind: 'merge'; value: unknown };

/**
 * Decode the two DataFieldOperator forms Foundry serializes over Socket.IO.
 * v14 uses the explicit operator envelope; v13 uses the legacy `==`/`-=`
 * key prefixes. Keeping this at the shared merge boundary applies the same
 * database semantics to every primary and embedded document Store.
 */
function resolveFoundryFieldOperation(rawKey: string, rawValue: unknown): {
    key: string;
    operation: FoundryFieldOperation;
} {
    if (rawKey.startsWith('==')) {
        return { key: rawKey.slice(2), operation: { kind: 'replace', value: rawValue } };
    }
    if (rawKey.startsWith('-=')) {
        return { key: rawKey.slice(2), operation: { kind: 'delete' } };
    }
    if (isRecord(rawValue)) {
        const operator = rawValue[FOUNDRY_OPERATOR_IDENTIFIER];
        if (operator === 'ForcedReplacement') {
            return { key: rawKey, operation: { kind: 'replace', value: rawValue.value } };
        }
        if (operator === 'ForcedDeletion') {
            return { key: rawKey, operation: { kind: 'delete' } };
        }
    }
    return { key: rawKey, operation: { kind: 'merge', value: rawValue } };
}

/**
 * Materialize nested operator values without retaining Foundry's transport
 * metadata in the cached document. This mirrors Foundry's applyDataOperators
 * behavior for replacement payloads and arrays.
 */
function materializeFoundryValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(materializeFoundryValue);
    if (!isRecord(value)) return value;

    const materialized: Record<string, unknown> = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
        const { key, operation } = resolveFoundryFieldOperation(rawKey, rawValue);
        if (!key || operation.kind === 'delete') continue;
        materialized[key] = materializeFoundryValue(operation.value);
    }
    return materialized;
}

function resolvePath(
    target: Record<string, unknown>,
    dottedKey: string,
): { parent: Record<string, unknown>; key: string } | null {
    const parts = dottedKey.split('.').filter(Boolean);
    const key = parts.pop();
    if (!key) return null;

    let parent = target;
    for (const part of parts) {
        if (!isRecord(parent[part])) parent[part] = {};
        parent = parent[part] as Record<string, unknown>;
    }
    return { parent, key };
}

/**
 * Deep-merge with Foundry-style dotted keys and serialized field operators.
 * Mutates target in place; returns it for convenience.
 */
export function deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
): Record<string, unknown> {
    for (const [rawKey, rawValue] of Object.entries(source)) {
        const { key, operation } = resolveFoundryFieldOperation(rawKey, rawValue);
        const path = resolvePath(target, key);
        if (!path) continue;

        if (operation.kind === 'delete') {
            delete path.parent[path.key];
            continue;
        }

        const value = operation.value;
        if (operation.kind === 'replace') {
            path.parent[path.key] = materializeFoundryValue(value);
        } else if (isRecord(value) && isRecord(path.parent[path.key])) {
            deepMerge(path.parent[path.key] as Record<string, unknown>, value);
        } else {
            path.parent[path.key] = materializeFoundryValue(value);
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
 * Resolve the ids removed by a delete event. Foundry delete broadcasts carry
 * the authoritative deleted ids in `result` as plain id strings — Foundry's
 * own client re-records `operation.ids = response.result` when handling the
 * broadcast, because the request operation's explicit ids can be empty (e.g.
 * `deleteAll: true`) or absent on the wire. Union the `result` string ids
 * with `operation.ids`/document ids so a delete can never silently no-op on
 * shape differences between initiator-mirrored and broadcast payloads.
 */
export function getDeletionIds<TDocument extends DocumentLike>(
    operation: Record<string, unknown> | undefined,
    result: unknown,
    docs: TDocument[],
): string[] {
    const ids = new Set<string>();
    if (Array.isArray(result)) {
        for (const entry of result) {
            if (typeof entry === 'string' && entry) ids.add(entry);
        }
    }
    for (const id of getOperationIds(operation, docs)) ids.add(id);
    return Array.from(ids);
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
 * Shared embedded-collection mutation for child-document events (Combatants,
 * CombatantGroups, Tokens, delta effects/items, …). Creates are idempotent by
 * id via {@link appendCreatedById} (mirror + broadcast both apply, ADR-0012);
 * updates deep-merge in place; deletes resolve ids via {@link getDeletionIds}
 * so broadcast-shaped payloads (string ids in `result`) apply (ADR-0031).
 */
export function applyEmbeddedCollectionChange<TChild extends DocumentLike>(
    existing: TChild[] | undefined,
    action: ModifyDocumentAction,
    result: unknown,
    operation?: Record<string, unknown>,
): TChild[] {
    const docs = toDocumentArray<TChild>(result);
    const children = existing || [];

    if (action === 'delete') {
        const ids = getDeletionIds(operation, result, docs);
        return children.filter(child => {
            const id = getDocumentId(child);
            return !id || !ids.includes(id);
        });
    }
    if (action === 'update') {
        for (const incoming of docs) {
            const id = getDocumentId(incoming);
            if (!id) continue;
            const index = children.findIndex(child => getDocumentId(child) === id);
            if (index >= 0) {
                deepMerge(children[index] as Record<string, unknown>, incoming as Record<string, unknown>);
            }
        }
        return children;
    }
    if (action === 'create') {
        return appendCreatedById(children, docs);
    }
    return children;
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
    private audienceSubjectsProvider: () => DocumentAccessSubject[] = () => [];

    /**
     * Per-type ownership resolver. Subclasses encode the type's visibility
     * policy (standard ownership map, whisper-based, derived from children, etc.).
     */
    protected abstract resolveOwnership(
        document: TDocument,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel;

    /**
     * Bind the authoritative subject roster after Store construction. Keeping
     * enumeration outside each Store avoids coupling type-specific visibility
     * policy back to UserStore while still including implicit GM access.
     */
    public bindAudienceSubjects(provider: () => DocumentAccessSubject[]): void {
        this.audienceSubjectsProvider = provider;
    }

    /** Resolve a document through this Store's existing type-specific policy. */
    protected audienceForDocument(document: TDocument | null | undefined): DocumentAudience {
        if (!document) return NO_DOCUMENT_AUDIENCE;
        const subjects = this.audienceSubjectsProvider();
        if (subjects.length === 0) return NO_DOCUMENT_AUDIENCE;

        const visibleUserIds = new Set<string>();
        const knownUserIds = new Set<string>();
        for (const subject of subjects) {
            if (!subject.userId) continue;
            knownUserIds.add(subject.userId);
            if (this.resolveOwnership(document, subject) >= DOCUMENT_VISIBILITY.LIST_VISIBLE) {
                visibleUserIds.add(subject.userId);
            }
        }
        if (knownUserIds.size > 0 && visibleUserIds.size === knownUserIds.size) {
            return ALL_DOCUMENT_AUDIENCE;
        }
        return documentAudienceForUsers(visibleUserIds);
    }

    protected audienceForDocumentId(documentId: string): DocumentAudience {
        return this.audienceForDocument(this.documents.get(documentId));
    }

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
        const beforeAudience = this.audienceForDocument(existing);
        this.documents.set(id, cloneDocument(document));
        const afterJson = stableJson(this.documents.get(id));
        if (afterJson !== beforeJson) {
            this.emitChanged(id, action, unionDocumentAudiences(beforeAudience, this.audienceForDocumentId(id)));
        }
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
        const beforeAudience = this.audienceForDocument(existing);
        const beforeOwnership = (existing as { ownership?: DocumentOwnershipMap }).ownership
            ? structuredClone((existing as { ownership?: DocumentOwnershipMap }).ownership)
            : undefined;
        deepMerge(existing as Record<string, unknown>, diff);
        this.documents.set(documentId, existing);
        if (stableJson(existing) !== before) {
            this.emitChanged(
                documentId,
                'update',
                unionDocumentAudiences(beforeAudience, this.audienceForDocument(existing)),
            );
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
        const audience = this.audienceForDocument(existing);
        const existed = this.documents.delete(documentId);
        this.staleDocumentIds.delete(documentId);
        if (existed) {
            this.emitChanged(documentId, 'delete', audience);
            this.emitListInvalidated('delete', {
                documentId,
                audience,
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
            const ids = getDeletionIds(operation, result, docs);
            if (ids.length === 0 && operation?.deleteAll === true) {
                // deleteAll with no resolvable ids: every cached document of
                // this type is gone. Fall back to the full key set so the
                // wipe still applies and emits.
                ids.push(...this.documents.keys());
            }
            for (const id of ids) {
                const doc = this.documents.get(id);
                const audience = this.audienceForDocument(doc);
                const existed = this.documents.delete(id);
                this.staleDocumentIds.delete(id);
                if (existed) {
                    this.emitChanged(id, 'delete', audience);
                    this.emitListInvalidated('delete', {
                        documentId: id,
                        audience,
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
                const beforeAudience = this.audienceForDocument(existing);
                const beforeOwnership = (existing as { ownership?: DocumentOwnershipMap }).ownership
                    ? structuredClone((existing as { ownership?: DocumentOwnershipMap }).ownership)
                    : undefined;
                deepMerge(existing as Record<string, unknown>, doc as Record<string, unknown>);
                this.documents.set(id, existing);
                if (stableJson(existing) !== before) {
                    this.emitChanged(
                        id,
                        'update',
                        unionDocumentAudiences(beforeAudience, this.audienceForDocument(existing)),
                    );
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
                    this.emitListInvalidated('create', {
                        documentId: id,
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
    protected emitChanged(
        documentId: string,
        action: ChangeAction,
        audience: DocumentAudience = this.audienceForDocumentId(documentId),
    ): void {
        if (!this.ready) return;
        const event: DocumentChangedEvent = { type: this.documentType, id: documentId, action, audience };
        logger.debug('PrimaryDocumentStore | Applied document change', event);
        this.emit('documentChanged', event);
        this.emit('primaryDocumentChanged', event);
    }

    /**
     * Emit a list-level invalidation event. Used for ownership transitions,
     * creates, and deletes. Silent during seeding.
     */
    protected emitListInvalidated(
        reason: string,
        options?: { documentId?: string; audience?: DocumentAudience },
    ): void {
        if (!this.ready) return;
        const audience = options?.audience
            ?? (options?.documentId ? this.audienceForDocumentId(options.documentId) : ALL_DOCUMENT_AUDIENCE);
        const event: DocumentListInvalidatedEvent = {
            type: this.documentType,
            reason,
            documentId: options?.documentId,
            audience,
        };
        // Keep user identifiers out of diagnostics while reporting whether an
        // invalidation is globally visible or scoped to an affected audience.
        logger.debug('PrimaryDocumentStore | Emitted list invalidation', {
            type: event.type,
            reason: event.reason,
            documentId: event.documentId,
            audience: event.audience.kind,
            targetCount: event.audience.kind === 'users' ? event.audience.userIds.length : 0,
        });
        this.emit('documentListInvalidated', event);
        this.emit('primaryDocumentListInvalidated', event);
    }

    /**
     * Diff an old/new ownership map and emit a listInvalidated targeted at users
     * whose effective permission changed. A transition can move a document
     * between hidden, card-only, read-only, and owned projections even when both
     * levels remain above LIST_VISIBLE.
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
        // A default permission change can alter every subject without an
        // explicit override, including their dashboard projection category.
        if (beforeDefault !== afterDefault) {
            logger.debug('PrimaryDocumentStore | Ownership default changed', {
                type: this.documentType,
                documentId,
                transition: `${beforeDefault}->${afterDefault}`,
            });
            this.emitListInvalidated('ownership-default-changed', {
                documentId,
                audience: ALL_DOCUMENT_AUDIENCE,
            });
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
        const transitionCounts: Record<string, number> = {};
        for (const userId of affectedUserIds) {
            const beforeLevel = before[userId] ?? beforeDefault;
            const afterLevel = after[userId] ?? afterDefault;
            if (beforeLevel !== afterLevel) {
                crossed.push(userId);
                // Aggregate only numeric transitions. User identities stay in
                // the internal audience list and never enter diagnostics.
                const transition = `${beforeLevel}->${afterLevel}`;
                transitionCounts[transition] = (transitionCounts[transition] ?? 0) + 1;
            }
        }

        if (crossed.length > 0) {
            logger.debug('PrimaryDocumentStore | Ownership users changed', {
                type: this.documentType,
                documentId,
                transitionCounts,
            });
            this.emitListInvalidated('ownership-user-changed', {
                documentId,
                audience: documentAudienceForUsers(crossed),
            });
        }
    }
}
