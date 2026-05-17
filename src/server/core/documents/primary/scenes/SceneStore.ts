import type { RawScene } from '@server/shared/types/documents';
import {
    PrimaryDocumentStore,
    type PrimaryDocumentType,
} from '../base/PrimaryDocumentStore';
import {
    getEffectiveOwnership,
    type DocumentAccessSubject,
    type DocumentOwnershipMap,
    type ResolvedDocumentOwnershipLevel,
} from '../base/ownership';

/**
 * Stub Scene Store (ADR-0011 Phase 7). Shape uniformity only — not registered
 * with `PrimaryDocumentCacheCoordinator` or `modifyDocumentRouter`. Scene uses
 * the standard ownership-map policy if/when wired, but canvas/scene visibility
 * needs its own design pass before active wiring.
 */
export class SceneStore extends PrimaryDocumentStore<RawScene> {
    public readonly documentType: PrimaryDocumentType = 'Scene';

    protected resolveOwnership(
        scene: RawScene,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        const ownership = scene.ownership as DocumentOwnershipMap | undefined;
        return getEffectiveOwnership(ownership, subject);
    }
}

export const sceneStore = new SceneStore();
