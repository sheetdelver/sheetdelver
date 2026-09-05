export class PrimaryDocumentCacheNotReadyError extends Error {
    public readonly status = 503;
    public readonly code = 'PRIMARY_DOCUMENT_CACHE_NOT_READY';

    constructor(documentType: string) {
        super(`${documentType} document cache is not ready; world bootstrap is still in progress`);
        this.name = 'PrimaryDocumentCacheNotReadyError';
    }
}
