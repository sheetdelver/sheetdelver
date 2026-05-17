import type { RawAdventure } from '@server/shared/types/documents';
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
 * Stub Adventure Store (ADR-0011 Phase 7). Shape uniformity only — not
 * registered with `PrimaryDocumentCacheCoordinator` or `modifyDocumentRouter`.
 *
 * Adventure is an import/export container in Foundry. GM-only placeholder
 * until a future round actually wires the subsystem and validates the shape.
 */
export class AdventureStore extends PrimaryDocumentStore<RawAdventure> {
    public readonly documentType: PrimaryDocumentType = 'Adventure';

    protected resolveOwnership(
        _adventure: RawAdventure,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        return subject.role >= FoundryUserRole.GAMEMASTER
            ? DocumentOwnershipLevel.OWNER
            : DocumentOwnershipLevel.NONE;
    }
}

export const adventureStore = new AdventureStore();
