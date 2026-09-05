import type { SceneDocument, TokenDocument, ActorDeltaDocument } from '@server/shared/types/documents';
import {
    applyEmbeddedCollectionChange,
    cloneDocument,
    deepMerge,
    getDeletionIds,
    getDocumentId,
    isRecord,
    PrimaryDocumentStore,
    stableJson,
    toDocumentArray,
    type ModifyDocumentAction,
    type PrimaryDocumentType,
} from '../base/PrimaryDocumentStore';
import {
    getEffectiveOwnership,
    type DocumentAccessSubject,
    type DocumentOwnershipMap,
    type ResolvedDocumentOwnershipLevel,
} from '../base/ownership';
import type { ActorStore } from '../actors/ActorStore';

/**
 * Scene primary-document Store (wired per ADR-0028 Phase 7, scene/token slice).
 *
 * Mirrors raw Scene documents and their embedded Token hierarchy. Foundry
 * translates every mutation of an unlinked token actor into operations under
 * the token's ActorDelta, so all of these arrive with a `parentUuid` rooted
 * at `Scene.<id>` and route here:
 *
 *   - `Token` events (`Scene.<id>`) → `scene.tokens[]`
 *   - `ActorDelta` events (`Scene.<id>.Token.<id>`) → merged into `token.delta`
 *   - `ActiveEffect` / `Item` events (`Scene.<id>.Token.<id>.ActorDelta.<id>`)
 *     → `token.delta.effects[]` / `token.delta.items[]`
 *   - `ActiveEffect` events beneath a delta Item
 *     (`Scene.<id>.Token.<id>.ActorDelta.<id>.Item.<id>`)
 *     → that Item's `effects[]`
 *
 * Consumers today are internal only: the combat encounter read model resolves
 * combatant display identity (combatant → token → actor) and unlinked-token
 * defeated status through {@link getToken}. Scene documents are NOT exposed
 * over routes or the SDK — canvas/scene visibility semantics still need their
 * own design pass (ADR-0011 Phase 7 stub note) before any external surface.
 */
export class SceneStore extends PrimaryDocumentStore<SceneDocument> {
    public readonly documentType: PrimaryDocumentType = 'Scene';

    private actorStore: ActorStore | null = null;

    /**
     * ActorDelta Item/ActiveEffect arrays are deltas against the base Actor,
     * so delete handling needs the base collection to distinguish removal of
     * a delta-only child from a tombstone for an inherited child.
     */
    public bindActorStore(actorStore: ActorStore): void {
        this.actorStore = actorStore;
    }

    protected resolveOwnership(
        scene: SceneDocument,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        const ownership = scene.ownership as DocumentOwnershipMap | undefined;
        return getEffectiveOwnership(ownership, subject);
    }

    /**
     * Privileged targeted token lookup. Returns a clone of just the token —
     * never the whole scene — so per-combatant-row resolution stays cheap.
     */
    public getToken(sceneId: string, tokenId: string): TokenDocument | null {
        const scene = this.documents.get(sceneId);
        if (!scene) return null;
        const token = (scene.tokens || []).find(t => getDocumentId(t) === tokenId);
        return token ? cloneDocument(token) : null;
    }

    protected applyEmbeddedChange(
        type: string,
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        const parentUuid = typeof operation?.parentUuid === 'string' ? operation.parentUuid : '';
        const parts = parentUuid.split('.');
        if (parts[0] !== 'Scene' || !parts[1]) return;
        const sceneId = parts[1];
        const scene = this.documents.get(sceneId);
        if (!scene) return;

        const before = stableJson(scene);

        if (type === 'Token' && parts.length === 2) {
            scene.tokens = applyEmbeddedCollectionChange(scene.tokens, action, result, operation);
        } else if (type === 'ActorDelta' && parts.length === 4 && parts[2] === 'Token' && parts[3]) {
            this.applyDeltaChange(scene, parts[3], action, result);
        } else if (
            (type === 'ActiveEffect' || type === 'Item')
            && parts.length === 6
            && parts[2] === 'Token'
            && parts[3]
            && parts[4] === 'ActorDelta'
            && parts[5]
        ) {
            this.applyDeltaChildChange(scene, parts[3], parts[5], type, action, result, operation);
        } else if (
            type === 'ActiveEffect'
            && parts.length === 8
            && parts[2] === 'Token'
            && parts[3]
            && parts[4] === 'ActorDelta'
            && parts[5]
            && parts[6] === 'Item'
            && parts[7]
        ) {
            this.applyDeltaItemEffectChange(scene, parts[3], parts[5], parts[7], action, result, operation);
        } else {
            return;
        }

        this.documents.set(sceneId, scene);
        if (action !== 'get' && stableJson(scene) !== before) {
            this.emitChanged(sceneId, 'update');
        }
    }

    /**
     * Apply a synthetic-token-actor mutation. Foundry represents a deleted
     * ActorDelta as a reset to a fresh empty delta owned by the same Token.
     */
    private applyDeltaChange(
        scene: SceneDocument,
        tokenId: string,
        action: ModifyDocumentAction,
        result: unknown,
    ): void {
        const token = (scene.tokens || []).find(t => getDocumentId(t) === tokenId);
        if (!token) return;
        if (action === 'delete') {
            token.delta = { _id: getDocumentId(token.delta || {}) || tokenId };
            return;
        }
        if (action !== 'update' && action !== 'create') return;
        for (const incoming of toDocumentArray<ActorDeltaDocument>(result)) {
            token.delta = token.delta || {};
            deepMerge(token.delta as Record<string, unknown>, incoming as Record<string, unknown>);
        }
    }

    /** Maintain `token.delta.effects[]` / `token.delta.items[]` collections. */
    private applyDeltaChildChange(
        scene: SceneDocument,
        tokenId: string,
        deltaId: string,
        type: 'ActiveEffect' | 'Item',
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        const token = (scene.tokens || []).find(t => getDocumentId(t) === tokenId);
        if (!token) return;
        token.delta = token.delta || { _id: deltaId };
        const base = this.getBaseActorCollection(token, type);
        if (type === 'ActiveEffect') {
            token.delta.effects = this.applyDeltaCollectionChange(
                token.delta.effects,
                base,
                action,
                result,
                operation,
            );
        } else {
            token.delta.items = this.applyDeltaCollectionChange(
                token.delta.items,
                base,
                action,
                result,
                operation,
            );
        }
    }

    /**
     * An effect beneath an Item belongs to that adopted delta Item, not to the
     * ActorDelta's top-level effect collection. If the Item was inherited,
     * clone it into the delta before applying the child mutation, matching
     * Foundry's parent-write adoption behavior.
     */
    private applyDeltaItemEffectChange(
        scene: SceneDocument,
        tokenId: string,
        deltaId: string,
        itemId: string,
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        const token = (scene.tokens || []).find(t => getDocumentId(t) === tokenId);
        if (!token) return;
        token.delta = token.delta || { _id: deltaId };
        token.delta.items = (token.delta.items || []).filter(isRecord);

        let item = token.delta.items.find(candidate =>
            isRecord(candidate)
            && getDocumentId(candidate) === itemId
            && candidate._tombstone !== true
        ) as Record<string, unknown> | undefined;
        if (!item) {
            const baseItem = this.getBaseActorCollection(token, 'Item')
                .find(candidate => getDocumentId(candidate) === itemId);
            if (!baseItem) return;
            item = cloneDocument(baseItem);
            token.delta.items = [
                ...token.delta.items.filter(candidate => !isRecord(candidate) || getDocumentId(candidate) !== itemId),
                item,
            ];
        }

        item.effects = applyEmbeddedCollectionChange(
            (Array.isArray(item.effects) ? item.effects : []).filter(isRecord),
            action,
            result,
            operation,
        );
    }

    /**
     * Apply Foundry EmbeddedCollectionDelta semantics rather than ordinary
     * array CRUD. Updates adopt inherited rows, inherited deletes become
     * tombstones, and restoreDelta removes local overrides.
     */
    private applyDeltaCollectionChange(
        current: unknown[] | undefined,
        base: Record<string, unknown>[],
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): Record<string, unknown>[] {
        let rows = (current || []).filter(isRecord).map(row => cloneDocument(row));
        const docs = toDocumentArray<Record<string, unknown>>(result);
        const ids = getDeletionIds(operation, result, docs);
        const resultIds = docs.map(getDocumentId).filter((id): id is string => Boolean(id));
        const affectedIds = Array.from(new Set([...ids, ...resultIds]));

        if (operation?.restoreDelta === true) {
            return rows.filter(row => {
                const id = getDocumentId(row);
                return !id || !affectedIds.includes(id);
            });
        }

        if (action === 'delete') {
            const baseIds = new Set(base.map(getDocumentId).filter((id): id is string => Boolean(id)));
            for (const id of affectedIds) {
                rows = rows.filter(row => getDocumentId(row) !== id);
                if (baseIds.has(id)) rows.push({ _id: id, _tombstone: true });
            }
            return rows;
        }

        if (action === 'update') {
            for (const incoming of docs) {
                const id = getDocumentId(incoming);
                if (!id) continue;
                const index = rows.findIndex(row => getDocumentId(row) === id);
                if (index >= 0 && rows[index]._tombstone !== true) {
                    deepMerge(rows[index], incoming);
                } else {
                    if (index >= 0) rows.splice(index, 1);
                    rows.push(cloneDocument(incoming));
                }
            }
            return rows;
        }

        if (action === 'create') {
            for (const incoming of docs) {
                const id = getDocumentId(incoming);
                const index = id ? rows.findIndex(row => getDocumentId(row) === id) : -1;
                if (index >= 0) {
                    if (rows[index]._tombstone === true) rows[index] = cloneDocument(incoming);
                    continue;
                }
                rows.push(cloneDocument(incoming));
            }
        }
        return rows;
    }

    private getBaseActorCollection(
        token: TokenDocument,
        type: 'Item' | 'ActiveEffect',
    ): Record<string, unknown>[] {
        if (!this.actorStore || !token.actorId) return [];
        const actor = this.actorStore.get(token.actorId);
        if (!actor) return [];
        const collection = type === 'Item'
            ? actor.items
            : (actor as Record<string, unknown>).effects;
        return Array.isArray(collection) ? collection.filter(isRecord) : [];
    }
}

export const sceneStore = new SceneStore();
