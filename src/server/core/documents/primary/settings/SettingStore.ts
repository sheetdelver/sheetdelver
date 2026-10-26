import type { SettingDocument } from '@server/shared/types/documents';
import {
    PrimaryDocumentStore,
    type PrimaryDocumentType,
    type DocumentChangedEvent,
    type ReconciliationSnapshot,
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
    private scopeEpoch = 0;
    private keyRevisions = new Map<string, number>();
    private observedKeys = new Map<string, string | null>();
    private publishingReconciliation = false;

    constructor() {
        super();
        // Register before downstream listeners so dependency fences retire synchronously.
        this.on('documentChanged', ({ id }: DocumentChangedEvent) => {
            const before = this.observedKeys.get(id);
            const document = this.documents.get(id);
            const after = document ? this.worldKey(document) : undefined;
            for (const key of this.publishingReconciliation ? [] : new Set([before, after])) {
                if (key) this.keyRevisions.set(key, (this.keyRevisions.get(key) ?? 0) + 1);
            }
            if (document) this.observedKeys.set(id, after ?? null); else this.observedKeys.delete(id);
        });
    }

    private worldKey(document: SettingDocument): string | null {
        return document.user == null && typeof document.key === 'string' ? document.key : null;
    }

    public override publishReconciliation(before: ReconciliationSnapshot): void {
        this.publishingReconciliation = true;
        try { super.publishReconciliation(before); }
        finally { this.publishingReconciliation = false; }
    }

    /** Private Core fence for declared world-setting dependencies. No raw values escape.
     * Revisions preserve relevant change-and-revert events; unscoped observations
     * and authoritative replacement still invalidate every dependency scope. */
    public getWorldKeysRevision(keys: readonly string[]): string {
        return JSON.stringify([this.ready, this.scopeEpoch,
            [...new Set(keys)].sort().map(key => [key, this.keyRevisions.get(key) ?? 0])]);
    }

    public override async seed(loader: () => Promise<SettingDocument[]>): Promise<void> {
        await super.seed(loader);
        this.scopeEpoch++;
        this.keyRevisions.clear();
        this.observedKeys = new Map([...this.documents].map(([id, row]) => [id, this.worldKey(row)]));
    }

    public override clear(reason?: string): void {
        this.scopeEpoch++;
        this.keyRevisions.clear(); this.observedKeys.clear();
        super.clear(reason);
    }

    public override markStale(id?: string, reason?: string): void {
        this.scopeEpoch++;
        super.markStale(id, reason);
    }

    public override observeMutation(): void {
        this.scopeEpoch++;
        super.observeMutation();
    }

    public hasWorldKey(key: string): boolean {
        return Array.from(this.documents.values()).some(row => row.key === key && row.user == null);
    }

    protected resolveOwnership(
        _setting: SettingDocument,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        return isGM(subject) ? DocumentOwnershipLevel.OWNER : DocumentOwnershipLevel.NONE;
    }

    /**
     * Privileged lookup by Foundry setting key (e.g.
     * `core.combatTrackerConfig`). This mirrors Foundry's
     * `WorldSettings.getSetting(key, null)` contract: user-scoped rows with
     * the same key are not eligible. Foundry persists `value`
     * JSON-serialized; string values that parse as JSON are decoded, anything
     * else is returned as-is. Returns undefined when the setting does not
     * exist.
     */
    public getValueByKey(key: string): unknown {
        for (const setting of this.documents.values()) {
            if (setting.key !== key || setting.user != null) continue;
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
