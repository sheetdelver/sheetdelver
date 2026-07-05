import type { SceneDocument, TokenDocument, ActorDeltaDocument } from '@server/shared/types/documents';
import {
    applyEmbeddedCollectionChange,
    cloneDocument,
    deepMerge,
    getDocumentId,
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
 *
 * Consumers today are internal only: the combat encounter read model resolves
 * combatant display identity (combatant → token → actor) and unlinked-token
 * defeated status through {@link getToken}. Scene documents are NOT exposed
 * over routes or the SDK — canvas/scene visibility semantics still need their
 * own design pass (ADR-0011 Phase 7 stub note) before any external surface.
 */
export class SceneStore extends PrimaryDocumentStore<SceneDocument> {
    public readonly documentType: PrimaryDocumentType = 'Scene';

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
        } else if (type === 'ActorDelta' && parts[2] === 'Token' && parts[3]) {
            this.applyDeltaChange(scene, parts[3], action, result);
        } else if ((type === 'ActiveEffect' || type === 'Item') && parts[2] === 'Token' && parts[3] && parts[4] === 'ActorDelta') {
            this.applyDeltaChildChange(scene, parts[3], type, action, result, operation);
        } else {
            return;
        }

        this.documents.set(sceneId, scene);
        if (action !== 'get' && stableJson(scene) !== before) {
            this.emitChanged(sceneId, 'update');
        }
    }

    /**
     * Merge a synthetic-token-actor update (`syntheticActorUpdate` requests
     * arrive as ActorDelta updates) into the owning token's `delta`.
     */
    private applyDeltaChange(
        scene: SceneDocument,
        tokenId: string,
        action: ModifyDocumentAction,
        result: unknown,
    ): void {
        if (action !== 'update' && action !== 'create') return;
        const token = (scene.tokens || []).find(t => getDocumentId(t) === tokenId);
        if (!token) return;
        for (const incoming of toDocumentArray<ActorDeltaDocument>(result)) {
            token.delta = token.delta || {};
            deepMerge(token.delta as Record<string, unknown>, incoming as Record<string, unknown>);
        }
    }

    /** Maintain `token.delta.effects[]` / `token.delta.items[]` collections. */
    private applyDeltaChildChange(
        scene: SceneDocument,
        tokenId: string,
        type: 'ActiveEffect' | 'Item',
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        const token = (scene.tokens || []).find(t => getDocumentId(t) === tokenId);
        if (!token) return;
        token.delta = token.delta || {};
        if (type === 'ActiveEffect') {
            token.delta.effects = applyEmbeddedCollectionChange(
                (token.delta.effects || []) as Array<{ _id?: string; id?: string }>,
                action,
                result,
                operation,
            );
        } else {
            token.delta.items = applyEmbeddedCollectionChange(
                (token.delta.items || []) as Array<{ _id?: string; id?: string }>,
                action,
                result,
                operation,
            );
        }
    }
}

export const sceneStore = new SceneStore();
