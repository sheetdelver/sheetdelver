import type { FogExplorationDocument } from '@server/shared/types/documents';
import {
    PrimaryDocumentStore,
    type PrimaryDocumentType,
} from '../base/PrimaryDocumentStore';
import {
    DocumentOwnershipLevel,
    isGM,
    type DocumentAccessSubject,
    type ResolvedDocumentOwnershipLevel,
} from '../base/ownership';

/**
 * Stub FogExploration Store (ADR-0011 Phase 7). Shape uniformity only — not
 * registered with `PrimaryDocumentCacheCoordinator` or `modifyDocumentRouter`.
 *
 * FogExploration is per-user state (one doc per user × scene). The minimal
 * `resolveOwnership` here is a placeholder: GMs see everything; non-GMs see
 * only their own fog docs. A real wiring pass should validate against actual
 * Foundry payloads.
 */
export class FogExplorationStore extends PrimaryDocumentStore<FogExplorationDocument> {
    public readonly documentType: PrimaryDocumentType = 'FogExploration';

    protected resolveOwnership(
        fog: FogExplorationDocument,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        if (isGM(subject)) return DocumentOwnershipLevel.OWNER;
        return fog.user === subject.userId ? DocumentOwnershipLevel.OWNER : DocumentOwnershipLevel.NONE;
    }
}

export const fogExplorationStore = new FogExplorationStore();
