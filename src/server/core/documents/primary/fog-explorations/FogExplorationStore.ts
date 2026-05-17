import type { RawFogExploration } from '@server/shared/types/documents';
import {
    PrimaryDocumentStore,
    type PrimaryDocumentType,
} from '../base/PrimaryDocumentStore';
import {
    DocumentOwnershipLevel,
    FoundryUserRole,
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
export class FogExplorationStore extends PrimaryDocumentStore<RawFogExploration> {
    public readonly documentType: PrimaryDocumentType = 'FogExploration';

    protected resolveOwnership(
        fog: RawFogExploration,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        if (subject.role >= FoundryUserRole.GAMEMASTER) return DocumentOwnershipLevel.OWNER;
        return fog.user === subject.userId ? DocumentOwnershipLevel.OWNER : DocumentOwnershipLevel.NONE;
    }
}

export const fogExplorationStore = new FogExplorationStore();
