export type PrimaryDocumentType =
    | 'Actor'
    | 'Cards'
    | 'ChatMessage'
    | 'Combat'
    | 'Item'
    | 'JournalEntry'
    | 'Macro'
    | 'Playlist'
    | 'RollTable';

export interface PrimaryDocumentStore<TDocument extends { id?: string; _id?: string }> {
    readonly documentType: PrimaryDocumentType;
    seed(loader: () => Promise<TDocument[]>): Promise<void>;
    clear(reason?: string): void;
    isReady(): boolean;
    list(): TDocument[];
    get(documentId: string): TDocument | null;
    upsert(document: TDocument): void;
    patch(documentId: string, diff: Record<string, unknown>): void;
    delete(documentId: string): void;
    markStale(documentId?: string, reason?: string): void;
}

export function cloneDocument<TDocument>(document: TDocument): TDocument {
    return structuredClone(document);
}

export function getDocumentId(document: { id?: string; _id?: string } | null | undefined): string | null {
    return document?._id || document?.id || null;
}
