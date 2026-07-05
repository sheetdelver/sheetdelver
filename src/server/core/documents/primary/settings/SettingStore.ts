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
 * Setting primary-document Store (wired per ADR-0028 Phase 7, settings slice).
 *
 * Setting is Foundry's key/value world-config document
 * (`{ key: "core.combatTrackerConfig", value: <JSON> }`). The store mirrors
 * raw Setting documents from bootstrap seed + `modifyDocument` events like
 * every other primary store.
 *
 * Visibility is GM-only and no routes expose Setting documents; consumers are
 * internal subsystems reading world configuration through the privileged
 * {@link getValueByKey} accessor (e.g. combat turn progression reading the
 * skip-defeated tracker toggle).
 */
export class SettingStore extends PrimaryDocumentStore<SettingDocument> {
    public readonly documentType: PrimaryDocumentType = 'Setting';

    protected resolveOwnership(
        _setting: SettingDocument,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        return isGM(subject) ? DocumentOwnershipLevel.OWNER : DocumentOwnershipLevel.NONE;
    }

    /**
     * Privileged lookup by Foundry setting key (e.g.
     * `core.combatTrackerConfig`). Foundry persists `value` JSON-serialized;
     * string values that parse as JSON are decoded, anything else is returned
     * as-is. Returns undefined when the setting does not exist.
     */
    public getValueByKey(key: string): unknown {
        for (const setting of this.documents.values()) {
            if (setting.key !== key) continue;
            const { value } = setting;
            if (typeof value === 'string') {
                try {
                    return JSON.parse(value);
                } catch {
                    return value;
                }
            }
            return value;
        }
        return undefined;
    }
}

export const settingStore = new SettingStore();
