import crypto from 'node:crypto';
import { logger } from '@shared/utils/logger';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { compendiumStore, CompendiumStore } from '@server/core/compendium/CompendiumStore';
import type {
    CompendiumIndexEntry,
    CompendiumIndexOptions,
    CompendiumPackManifest,
    CompendiumPackMetadata,
    GameDataPackEnvelope,
} from '@server/core/compendium/types';
import type { CompendiumPackConfig, CompendiumPackDeclaration } from '@shared/sdk';
import { isSdkError } from '@shared/sdk/errors';

export interface CompendiumTransport {
    isConnected: boolean;
    emitSocketEvent<T>(event: string, ...payloads: unknown[]): Promise<T>;
    dispatchDocumentSocket(
        type: string,
        action: string,
        operation?: unknown,
        parent?: unknown,
        failHard?: boolean,
    ): Promise<unknown>;
    withHeartbeatPaused?<T>(operation: () => Promise<T>): Promise<T>;
}

export interface CompendiumServiceDeps {
    transport: CompendiumTransport;
    store?: CompendiumStore;
}

export interface GetPackEntriesOptions extends CompendiumIndexOptions {
    index?: boolean;
    metadata?: CompendiumPackMetadata;
}

export interface HydratePacksResult {
    manifest: CompendiumPackManifest;
    hydrated: number;
    skipped: number;
    missing: number;
}

// Reconciled with Foundry's CONST.COMPENDIUM_DOCUMENT_TYPES
// (https://foundryvtt.com/api/variables/CONST.COMPENDIUM_DOCUMENT_TYPES.html).
// These overlap with primary document classes by design — pack reads can return
// the same Actor/Item/etc. classes used by world Stores. The boundary between
// pack scope and world scope is `operation.pack`, not the document `type`
// (see ADR-0021 "Pack reads do not mirror into world Stores").
const CORE_PACK_DOCUMENT_TYPES = ['Item', 'Actor', 'JournalEntry', 'RollTable', 'Scene', 'Macro', 'Playlist', 'Cards', 'Adventure'] as const;
const DEFAULT_PACK_DOCUMENT_TYPES = ['Item', 'Actor', 'JournalEntry', 'RollTable'] as const;
const DEFAULT_INDEX_FIELDS = ['name', 'img', 'type'] as const;
const INDEX_IDENTITY_FIELDS = ['_id', ...DEFAULT_INDEX_FIELDS] as const;

function responseArray<T = unknown>(response: unknown): T[] | null {
    if (response && typeof response === 'object'
        && ((response as { error?: unknown }).error || (response as { success?: boolean }).success === false)) return null;
    if (Array.isArray(response)) return response as T[];
    if (response && typeof response === 'object' && Array.isArray((response as { result?: unknown }).result)) {
        return (response as { result: T[] }).result;
    }
    return null;
}

function inferDocumentType(packId: string, metadata?: CompendiumPackMetadata | null): string {
    const declared = metadata?.type || metadata?.entity || metadata?.documentName;
    if (typeof declared === 'string' && declared.trim()) return declared;
    return packId.includes('tables') ? 'RollTable' : 'Item';
}

function typeFallbacks(type: string, includeFullDocumentAliases = false): string[] {
    const typesToTry = [type];
    if (type === 'RollTable') typesToTry.push('Tables', 'RollTables');
    else if (type === 'Item') typesToTry.push('Items');
    else if (type === 'JournalEntry') typesToTry.push(includeFullDocumentAliases ? 'JournalEntries' : 'Journal', 'Journal');
    else if (includeFullDocumentAliases && type === 'Actor') typesToTry.push('Actors');
    return Array.from(new Set(typesToTry));
}

function packDocumentTypes(type?: string | null): string[] {
    const normalized = typeof type === 'string' ? type.trim() : '';
    if (CORE_PACK_DOCUMENT_TYPES.includes(normalized as typeof CORE_PACK_DOCUMENT_TYPES[number])) {
        return [normalized];
    }
    return [...DEFAULT_PACK_DOCUMENT_TYPES];
}

function documentMatchesId(document: unknown, documentId: string): document is Record<string, unknown> {
    if (!document || typeof document !== 'object') return false;
    const row = document as { _id?: unknown; id?: unknown; uuid?: unknown };
    if (row._id === documentId || row.id === documentId) return true;
    return typeof row.uuid === 'string' && (row.uuid === documentId || row.uuid.endsWith(`.${documentId}`));
}

/**
 * Collapse pack documents to one per `_id` (falling back to `id`). A compendium pack is
 * primary-keyed by `_id`; duplicate transport rows must not multiply shard rows.
 * Documents without an id are preserved as-is.
 */
function dedupeById<T extends Record<string, unknown>>(documents: T[]): T[] {
    const byId = new Map<string, T>();
    const noId: T[] = [];
    for (const doc of documents) {
        const id = doc && typeof doc === 'object'
            ? (doc as { _id?: unknown; id?: unknown })._id ?? (doc as { id?: unknown }).id
            : undefined;
        if (typeof id === 'string' && id) byId.set(id, doc);
        else noId.push(doc);
    }
    return [...byId.values(), ...noId];
}

function findDocumentInResponse(response: unknown, documentId: string): Record<string, unknown> | null {
    const rows = responseArray<Record<string, unknown>>(response);
    return rows?.find(row => documentMatchesId(row, documentId)) || null;
}

function normalizeFields(fields?: readonly string[] | null): string[] {
    if (!fields?.length) return [];
    return Array.from(new Set(fields.map(field => String(field).trim()).filter(Boolean))).sort();
}

function requestedIndexFields(fields?: readonly string[] | null): string[] | undefined {
    return fields?.length ? normalizeFields([...INDEX_IDENTITY_FIELDS, ...fields]) : undefined;
}

function getPathValue(document: Record<string, unknown>, path: string): unknown {
    if (Object.prototype.hasOwnProperty.call(document, path)) return document[path];

    return path.split('.').reduce<unknown>((current, segment) => {
        if (!current || typeof current !== 'object') return undefined;
        return (current as Record<string, unknown>)[segment];
    }, document);
}

function indexCoversFields(index: unknown[], fields: readonly string[]): boolean {
    const required = normalizeFields(fields);
    if (required.length === 0 || index.length === 0) return true;

    return index.every(entry => {
        if (!entry || typeof entry !== 'object') return false;
        const row = entry as Record<string, unknown>;
        return required.every(field => getPathValue(row, field) !== undefined);
    });
}

function hasIndexIdentity(index: unknown[]): boolean {
    if (index.length === 0) return true;

    return index.every(entry => {
        if (!entry || typeof entry !== 'object') return false;
        const row = entry as { _id?: unknown; id?: unknown; name?: unknown };
        return typeof (row._id || row.id) === 'string' && row.name !== undefined;
    });
}

function indexMatchesRequest(index: unknown[], fields?: readonly string[] | null): boolean {
    return hasIndexIdentity(index) && indexCoversFields(index, fields || []);
}

/** Read-only pack hydration. Persisted rows are snapshots, not freshness proof.
 * Lifecycle hydration reads the declared contents from Foundry; ordinary SDK
 * reads remain cache-only. See ADR-0075 for the replaced ID/name hash policy. */
export class CompendiumService {
    private readonly transport: CompendiumTransport;
    private readonly store: CompendiumStore;

    public constructor(deps: CompendiumServiceDeps) {
        this.transport = deps.transport;
        this.store = deps.store || compendiumStore;
    }

    /**
     * Passive seed from the bootstrap envelope. Delegates to
     * `CompendiumStore.seedPackMetadataFromGameData(...)`.
     *
     * Per ADR-0021 this issues zero transport calls. It records which packs
     * exist; hydration of index rows or full documents is module-driven.
     */
    public seedPackMetadataFromGameData(gameData: GameDataPackEnvelope | null | undefined, reason?: string): void {
        this.store.seedPackMetadataFromGameData(gameData, reason);
    }

    /** Revalidate every present declared pack before adapter initialization or
     * recovery. Absent optional packs cost no transport call. A failed source
     * read rejects hydration so bootstrap/context refresh cannot publish stale
     * data as ready. */
    public async hydratePacks(
        systemId: string,
        config: CompendiumPackConfig,
    ): Promise<HydratePacksResult> {
        logger.info(`CompendiumService | Hydrating declared packs for ${systemId}...`);

        const existingManifest = await this.store.getManifest(systemId) || {
            systemId,
            packs: {},
            _instanceId: crypto.randomUUID(),
        };

        const newManifest: CompendiumPackManifest = {
            ...existingManifest,
            packs: { ...existingManifest.packs },
        };

        let hydrated = 0;
        let skipped = 0;
        let missing = 0;
        const failures: Error[] = [];

        for (const declaration of config.packs) {
            try {
                const result = await this.hydrateDeclaration(systemId, declaration, newManifest);
                if (result === 'hydrated') hydrated++;
                else if (result === 'skipped') skipped++;
                else if (result === 'missing') missing++;
            } catch (err: unknown) {
                const message = `Failed to hydrate pack ${declaration.id}: ${getErrorMessage(err)}`;
                logger.error(`CompendiumService | ${message}`);
                failures.push(new Error(message));
            }
        }

        if (failures.length) throw new AggregateError(failures,
            `Compendium refresh failed: ${failures.map(error => error.message).join('; ')}`);

        if (hydrated > 0) {
            await this.store.setManifest(newManifest);
        }

        logger.info(
            `CompendiumService | Hydrated ${hydrated}/${config.packs.length} declared packs for ${systemId} ` +
            `(${skipped} verified unchanged; ${missing} missing).`
        );

        return { manifest: newManifest, hydrated, skipped, missing };
    }

    public async hydratePack(
        systemId: string,
        declaration: CompendiumPackDeclaration,
    ): Promise<'hydrated' | 'skipped' | 'missing'> {
        const existingManifest = await this.store.getManifest(systemId) || {
            systemId,
            packs: {},
            _instanceId: crypto.randomUUID(),
        };

        const manifest: CompendiumPackManifest = {
            ...existingManifest,
            packs: { ...existingManifest.packs },
        };

        const result = await this.hydrateDeclaration(systemId, declaration, manifest);
        if (result === 'hydrated') await this.store.setManifest(manifest);
        return result;
    }

    /** Fetch full documents or the requested index fields once per lifecycle
     * hydration. ID/name indices and modification timestamps do not establish
     * embedded-document freshness, including shipped pack replacements. */
    private async hydrateDeclaration(
        systemId: string,
        declaration: CompendiumPackDeclaration,
        manifest: CompendiumPackManifest,
    ): Promise<'hydrated' | 'skipped' | 'missing'> {
        const packId = declaration.id;
        const assertCurrent = this.captureScope(packId);
        if (!this.store.hasPackMetadata(packId)) {
            logger.warn(`[module:${systemId}] pack ${packId} not found in game.data.packs; skipping hydration.`);
            return 'missing';
        }

        const packFields = this.getPackFields(declaration);
        let documents: Record<string, unknown>[];
        if (declaration.hydrate) {
            const response = await this.transport.emitSocketEvent<unknown>('modifyDocument', {
                type: inferDocumentType(packId, this.getDeclarationMetadata(declaration)),
                action: 'get',
                operation: { pack: packId, index: false, query: {} },
            }, 5000);
            const rows = responseArray<Record<string, unknown>>(response);
            if (!rows) throw new Error(`Full pack read failed: ${packId}`);
            documents = rows;
        } else {
            documents = await this.getPackEntries(packId, {
                index: true, fields: packFields, metadata: this.getDeclarationMetadata(declaration),
            });
        }
        documents = dedupeById(documents);
        assertCurrent();
        if (declaration.hydrate) {
            // Preserve the default discovery index without a second network
            // read or retaining whole documents in the index tier.
            this.writeIndex(packId, documents.map(document => Object.fromEntries(
                ['_id', 'id', 'uuid', ...DEFAULT_INDEX_FIELDS]
                    .filter(key => document[key] !== undefined)
                    .map(key => [key, document[key]]))));
        }
        const currentHash = this.computeHash(documents, declaration);
        const existing = manifest.packs[packId];
        if (existing?.hash === currentHash) {
            const persisted = await this.store.getPackRows(systemId, packId);
            assertCurrent();
            if (persisted && this.computeHash(persisted, declaration) === currentHash) {
                logger.debug(`CompendiumService | Pack ${packId} verified unchanged against Foundry.`);
                return 'skipped';
            }
        }

        await this.store.setPackRows(systemId, packId, documents);
        assertCurrent();
        manifest.packs[packId] = {
            id: packId, hash: currentHash, lastUpdated: Date.now(), rowCount: documents.length,
            hydrate: declaration.hydrate, fields: declaration.fields,
        };
        logger.info(`CompendiumService | Refreshed pack ${packId} (${declaration.hydrate ? 'FULL' : 'INDEX'}).`);
        return 'hydrated';
    }

    public async getPackEntries(packId: string, options: GetPackEntriesOptions = { index: true }): Promise<CompendiumIndexEntry[]> {
        const fetchEntries = async () => this.fetchPackEntries(packId, options);
        return this.transport.withHeartbeatPaused
            ? this.transport.withHeartbeatPaused(fetchEntries)
            : fetchEntries();
    }

    private async fetchPackEntries(packId: string, options: GetPackEntriesOptions): Promise<CompendiumIndexEntry[]> {
        const assertCurrent = this.captureScope(packId);
        logger.debug(`CompendiumService | Fetching entries for pack ${packId} (options: ${JSON.stringify(options)})...`);
        const indexFields = requestedIndexFields(options.fields);
        const metadata = this.store.getPackMetadata(packId) || options.metadata;
        const documentType = inferDocumentType(packId, metadata);

        try {
            try {
                logger.debug(`[CompendiumService] [TRACE] getPackEntries Strategy 1 (modifyDocument): ${packId}`);
                const response = await this.transport.emitSocketEvent<unknown>('modifyDocument', {
                    type: documentType,
                    action: 'get',
                    operation: {
                        pack: packId,
                        index: true,
                        query: {},
                        ...(indexFields ? { indexFields } : {}),
                    },
                }, 5000);
                const rows = responseArray<CompendiumIndexEntry>(response);
                if (rows && indexMatchesRequest(rows, options.fields)) {
                    assertCurrent();
                    this.writeIndex(packId, rows, { fields: options.fields });
                    return rows;
                }
            } catch (error) {
                if (isSdkError(error) && error.code === 'permission_denied') throw error;
                // Preserve the existing socket ladder: failed probes fall through.
            }

            try {
                logger.debug(`[CompendiumService] [TRACE] getPackEntries Strategy 2 (getDocuments): ${packId}`);
                const response = await this.transport.emitSocketEvent<unknown>(
                    'getDocuments',
                    documentType,
                    {
                        index: true,
                        pack: packId,
                        query: {},
                        ...(indexFields ? { indexFields } : {}),
                    },
                    5000,
                );
                const rows = responseArray<CompendiumIndexEntry>(response);
                if (rows && indexMatchesRequest(rows, options.fields)) {
                    assertCurrent();
                    this.writeIndex(packId, rows, { fields: options.fields });
                    return rows;
                }
            } catch (error) {
                if (isSdkError(error) && error.code === 'permission_denied') throw error;
                // Preserve the existing socket ladder: failed probes fall through.
            }

            try {
                logger.debug(`[CompendiumService] [TRACE] getPackEntries Strategy 3 (getCompendiumIndex): ${packId}`);
                const response = await this.transport.emitSocketEvent<unknown>('getCompendiumIndex', packId, 5000);
                const rows = responseArray<CompendiumIndexEntry>(response);
                if (rows && indexMatchesRequest(rows, options.fields)) {
                    assertCurrent();
                    this.writeIndex(packId, rows, { fields: options.fields });
                    return rows;
                }
            } catch (error) {
                if (isSdkError(error) && error.code === 'permission_denied') throw error;
                // Preserve the existing socket ladder: failed probes fall through.
            }

            logger.error(`CompendiumService | All entry fetch strategies failed for pack ${packId}`);
            throw new Error(`Pack index entries unavailable: ${packId}; all strategies failed`);
        } catch (error) {
            logger.warn(`CompendiumService | getPackEntries failed for ${packId}: ${error}`);
            throw error;
        }
    }

    public async getPackIndex(
        packId: string,
        type: string,
        options: CompendiumIndexOptions & { metadata?: CompendiumPackMetadata } = {},
    ): Promise<CompendiumIndexEntry[]> {
        const assertCurrent = this.captureScope(packId);
        type = inferDocumentType(packId, this.store.getPackMetadata(packId) || options.metadata || { id: packId, type });
        try {
            logger.debug(`CompendiumService | Fetching index for pack ${packId} (type: ${type})...`);
            const indexFields = requestedIndexFields(options.fields);

            try {
                const response = await this.transport.emitSocketEvent<unknown>('getCompendiumIndex', packId, 3000);
                const rows = responseArray<CompendiumIndexEntry>(response);
                if (rows && indexMatchesRequest(rows, options.fields)) {
                    assertCurrent();
                    this.writeIndex(packId, rows, options);
                    return rows;
                }
            } catch (error) {
                if (isSdkError(error) && error.code === 'permission_denied') throw error;
                // Preserve the existing socket ladder: failed probes fall through.
            }

            for (const t of typeFallbacks(type)) {
                try {
                    const response = await this.transport.emitSocketEvent<unknown>('getDocuments', {
                        type: t,
                        operation: {
                            pack: packId,
                            index: true,
                            query: {},
                            ...(indexFields ? { indexFields } : {}),
                        },
                    }, 2000);
                    const rows = responseArray<CompendiumIndexEntry>(response);
                    if (rows && indexMatchesRequest(rows, options.fields)) {
                        assertCurrent();
                        this.writeIndex(packId, rows, options);
                        return rows;
                    }
                } catch (error) {
                    if (isSdkError(error) && error.code === 'permission_denied') throw error;
                    // Try next type alias.
                }
            }

            try {
                const response = await this.transport.dispatchDocumentSocket(type, 'get', {
                    pack: packId,
                    index: true,
                    query: {},
                    broadcast: false,
                    ...(indexFields ? { indexFields } : {}),
                }, undefined, false);
                const rows = responseArray<CompendiumIndexEntry>(response);
                if (rows && indexMatchesRequest(rows, options.fields)) {
                    assertCurrent();
                    this.writeIndex(packId, rows, options);
                    return rows;
                }
            } catch (error) {
                if (isSdkError(error) && error.code === 'permission_denied') throw error;
                // Ignore packData errors, matching the old CoreSocket behavior.
            }

            throw new Error(`Pack index unavailable: ${packId}; all strategies failed`);
        } catch (error) {
            logger.warn(`CompendiumService | getPackIndex failed for ${packId}: ${error}`);
            throw error;
        }
    }

    public async getPackDocuments(packId: string, type: string): Promise<unknown[]> {
        const assertCurrent = this.captureScope(packId);
        type = inferDocumentType(packId, this.store.getPackMetadata(packId) || { id: packId, type });
        try {
            logger.debug(`CompendiumService | Fetching full documents for pack ${packId} (type: ${type})...`);

            for (const t of typeFallbacks(type, true)) {
                try {
                    const response = await this.transport.emitSocketEvent<unknown>('getDocuments', {
                        type: t,
                        operation: { pack: packId, query: {} },
                    }, 5000);
                    const rows = responseArray(response);
                    if (rows) { assertCurrent(); return rows; }
                } catch (error) {
                    if (isSdkError(error) && error.code === 'permission_denied') throw error;
                    // Try next type alias.
                }
            }

            try {
                const response = await this.transport.dispatchDocumentSocket(type, 'get', {
                    pack: packId,
                    query: {},
                    broadcast: false,
                }, undefined, false);
                const rows = responseArray(response);
                if (rows) { assertCurrent(); return rows; }
            } catch (error) {
                if (isSdkError(error) && error.code === 'permission_denied') throw error;
                // Ignore errors, matching the old CoreSocket behavior.
            }

            throw new Error(`Pack documents unavailable: ${packId}; all strategies failed`);
        } catch (error) {
            logger.warn(`CompendiumService | getPackDocuments failed for ${packId}: ${error}`);
            throw error;
        }
    }

    public async getPackDocument(
        packId: string,
        documentId: string,
        type?: string | null,
    ): Promise<Record<string, unknown> | null> {
        if (!this.transport.isConnected) return null;
        if (this.store.getPackMetadata(packId)) type = inferDocumentType(packId, this.store.getPackMetadata(packId));

        const trialTimeout = 500;
        for (const t of packDocumentTypes(type)) {
            if (!this.transport.isConnected) return null;

            try {
                logger.debug(`[CompendiumService] [TRACE] getPackDocument Strategy 1 (modifyDocument): ${packId} ${t} ${documentId}`);
                const response = await this.transport.emitSocketEvent<unknown>('modifyDocument', {
                    type: t,
                    action: 'get',
                    operation: { pack: packId, query: { _id: documentId } },
                }, trialTimeout);
                const found = findDocumentInResponse(response, documentId);
                if (found) return found;
            } catch (error) {
                if (isSdkError(error) && error.code === 'permission_denied') throw error;
                // Preserve the legacy fetchByUuid ladder: failed probes fall through.
            }

            try {
                logger.debug(`[CompendiumService] [TRACE] getPackDocument Strategy 2 (getDocuments): ${packId} ${t} ${documentId}`);
                const response = await this.transport.emitSocketEvent<unknown>('getDocuments', {
                    type: t,
                    operation: { pack: packId, query: { _id: documentId } },
                }, trialTimeout);
                const found = findDocumentInResponse(response, documentId);
                if (found) return found;
            } catch (error) {
                if (isSdkError(error) && error.code === 'permission_denied') throw error;
                // Try the next inferred type.
            }
        }

        return null;
    }

    private writeIndex(
        packId: string,
        index: CompendiumIndexEntry[],
        options: CompendiumIndexOptions & { metadata?: CompendiumPackMetadata } = {},
    ): void {
        const metadata = this.store.getPackMetadata(packId) || options.metadata || { id: packId, type: inferDocumentType(packId) };
        this.store.setPackIndex(packId, metadata, index, { fields: options.fields });
    }
    private captureScope(packId: string): () => void {
        const metadata = JSON.stringify(this.store.getPackMetadata(packId));
        const revision = this.store.getPackContentRevision(packId);
        return () => {
            if (revision !== this.store.getPackContentRevision(packId) || metadata !== JSON.stringify(this.store.getPackMetadata(packId))) {
                throw new Error(`Pack index scope changed: ${packId}; retry with current metadata/content`);
            }
        };
    }

    private getPackFields(declaration: CompendiumPackDeclaration): string[] {
        return normalizeFields(declaration.fields?.length ? declaration.fields : DEFAULT_INDEX_FIELDS);
    }

    private getDeclarationMetadata(declaration: CompendiumPackDeclaration): CompendiumPackMetadata {
        return { ...this.store.getPackMetadata(declaration.id),
            id: declaration.id,
            type: inferDocumentType(declaration.id, this.store.getPackMetadata(declaration.id) || { id: declaration.id, type: declaration.type }),
        };
    }

    private computeHash(documents: unknown[], declaration: CompendiumPackDeclaration): string {
        // Object key and pack row order are incidental; embedded array order is
        // meaningful. Include the declaration so different field coverage can
        // never reuse the same persisted snapshot as proof of completeness.
        const canonical = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(canonical);
            if (value && typeof value === 'object') return Object.fromEntries(
                Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
            return value;
        };
        const content = JSON.stringify({
            type: inferDocumentType(declaration.id, this.getDeclarationMetadata(declaration)),
            hydrate: !!declaration.hydrate,
            fields: declaration.hydrate ? [] : this.getPackFields(declaration),
            rows: documents.map(row => JSON.stringify(canonical(row))).sort(),
        });
        return `content-v1:${crypto.createHash('sha256').update(content).digest('hex')}`;
    }
}
