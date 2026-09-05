import type {
    DocumentChangedEvent,
    PrimaryDocumentType,
} from '@server/core/documents/primary/base/PrimaryDocumentStore';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { itemStore } from '@server/core/documents/primary/items/ItemStore';

export interface SyncTokenSource {
    on(event: 'documentChanged', listener: (event: DocumentChangedEvent) => void): unknown;
    off(event: 'documentChanged', listener: (event: DocumentChangedEvent) => void): unknown;
}

export interface SyncTokenServiceDeps {
    sources?: SyncTokenSource[];
    trackedTypes?: readonly PrimaryDocumentType[];
    now?: () => number;
    initializeToken?: boolean;
}

interface SourceSubscription {
    source: SyncTokenSource;
    listener: (event: DocumentChangedEvent) => void;
}

const DEFAULT_TRACKED_TYPES: readonly PrimaryDocumentType[] = ['Actor', 'Item'];

export class SyncTokenService {
    private readonly now: () => number;
    private readonly trackedTypes: Set<PrimaryDocumentType>;
    private readonly subscriptions: SourceSubscription[] = [];
    private tokenValue: number | null;

    constructor(deps: SyncTokenServiceDeps = {}) {
        this.now = deps.now ?? Date.now;
        this.trackedTypes = new Set(deps.trackedTypes ?? DEFAULT_TRACKED_TYPES);
        this.tokenValue = deps.initializeToken === false ? null : this.now();

        for (const source of deps.sources ?? []) {
            this.subscribe(source);
        }
    }

    /**
     * Current status-facing token. The payload keeps the historical string
     * shape while this service owns the numeric source of truth.
     */
    public getCurrentToken(): string | undefined {
        return this.tokenValue == null ? undefined : String(this.tokenValue);
    }

    public dispose(): void {
        for (const { source, listener } of this.subscriptions) {
            source.off('documentChanged', listener);
        }
        this.subscriptions.length = 0;
    }

    private subscribe(source: SyncTokenSource): void {
        const listener = (event: DocumentChangedEvent) => {
            this.handleDocumentChanged(event);
        };

        source.on('documentChanged', listener);
        this.subscriptions.push({ source, listener });
    }

    private handleDocumentChanged(event: DocumentChangedEvent): void {
        if (!this.trackedTypes.has(event.type)) return;

        const timestamp = this.now();
        // Several modifyDocument events can arrive in one millisecond. Keep the
        // timestamp readable, but force every observed Actor/Item change to
        // advance the token.
        this.tokenValue = this.tokenValue == null
            ? timestamp
            : Math.max(timestamp, this.tokenValue + 1);
    }
}

export const syncTokenService = new SyncTokenService({
    sources: [actorStore, itemStore],
});
