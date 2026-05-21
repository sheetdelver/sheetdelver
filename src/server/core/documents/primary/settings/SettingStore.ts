import type { SettingDocument } from '@server/shared/types/documents';
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
 * Stub Setting Store (ADR-0011 Phase 7). Shape uniformity only — not
 * registered with `PrimaryDocumentCacheCoordinator` or `modifyDocumentRouter`.
 *
 * Setting is a key/value world-config doc in Foundry. Admin/GM placeholder
 * until a future round wires the subsystem against real payloads.
 */
export class SettingStore extends PrimaryDocumentStore<SettingDocument> {
    public readonly documentType: PrimaryDocumentType = 'Setting';

    protected resolveOwnership(
        _setting: SettingDocument,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        return isGM(subject) ? DocumentOwnershipLevel.OWNER : DocumentOwnershipLevel.NONE;
    }
}

export const settingStore = new SettingStore();
