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
}

export interface HydratePacksResult {
    manifest: CompendiumPackManifest;
    hydrated: number;
    skipped: number;
    missing: number;
}

const CORE_PACK_DOCUMENT_TYPES = ['Item', 'Actor', 'JournalEntry', 'RollTable', 'Scene', 'Macro', 'Playlist'] as const;
const DEFAULT_PACK_DOCUMENT_TYPES = ['Item', 'Actor', 'JournalEntry', 'RollTable'] as const;
const DEFAULT_INDEX_FIELDS = ['name', 'img', 'type'] as const;

function responseArray<T = unknown>(response: unknown): T[] | null {
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

function findDocumentInResponse(response: unknown, documentId: string): Record<string, unknown> | null {
    const rows = responseArray<Record<string, unknown>>(response);
    return rows?.find(row => documentMatchesId(row, documentId)) || null;
}

function normalizeFields(fields?: readonly string[] | null): string[] {
    if (!fields?.length) return [];
    return Array.from(new Set(fields.map(field => String(field).trim()).filter(Boolean))).sort();
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

function hasFreshnessInputs(index: unknown[]): boolean {
    if (index.length === 0) return true;

    return index.every(entry => {
        if (!entry || typeof entry !== 'object') return false;
        const row = entry as { _id?: unknown; id?: unknown; name?: unknown };
        return typeof (row._id || row.id) === 'string' && row.name !== undefined;
    });
}

/**
 * Read-only service for compendium pack hydration and on-demand fetch primitives.
 *
 * Per ADR-0021 there is one store and one service for the compendium domain.
 * Bootstrap is passive: `seedPackMetadataFromGameData(...)` records which packs
 * exist from `game.data.packs` and never calls Foundry. Hydration is module-
 * driven: `hydratePack(...)` / `hydratePacks(...)` consult the persistent
 * manifest and short-circuit on a fresh hash, otherwise issue one pack-scoped
 * freshness fetch and refresh the shard per the module's `hydrate` / `fields`
 * policy.
 *
 * The service has no `upsert` / `patch` / `delete` for compendium documents —
 * pack contents are owned upstream by Foundry.
 */
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

    /**
     * Hydrate every pack declared by a module's `info.json` config.
     *
     * For each declared pack the service consults the persistent manifest first.
     * A fresh hash plus on-disk rows means zero transport calls for that pack.
     * Otherwise the service issues one pack-scoped freshness fetch and refreshes
     * the shard per `hydrate` / `fields`. Packs declared in `info.json` but not
     * present in `game.data.packs` are logged and skipped without any transport
     * call (declared-but-absent policy).
     */
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

        for (const declaration of config.packs) {
            try {
                const result = await this.hydrateDeclaration(systemId, declaration, newManifest);
                if (result === 'hydrated') hydrated++;
                else if (result === 'skipped') skipped++;
                else if (result === 'missing') missing++;
            } catch (err: unknown) {
                logger.error(`CompendiumService | Failed to hydrate pack ${declaration.id}: ${getErrorMessage(err)}`);
            }
        }

        if (hydrated > 0) {
            await this.store.setManifest(newManifest);
        }

        logger.info(
            `CompendiumService | Hydrated ${hydrated}/${config.packs.length} declared packs for ${systemId} ` +
            `(${skipped} skipped, fresh; ${missing} missing).`
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

    /**
     * Per-pack hydration flow used by `hydratePack` / `hydratePacks`.
     *
     * Order matters: check pre-filed metadata first so declared-but-absent
     * packs cost zero transport calls; check the persistent manifest hash
     * second so a fresh warm restart also costs zero. Only stale or missing
     * packs reach the freshness fetch.
     */
    private async hydrateDeclaration(
        systemId: string,
        declaration: CompendiumPackDeclaration,
        manifest: CompendiumPackManifest,
    ): Promise<'hydrated' | 'skipped' | 'missing'> {
        const packId = declaration.id;

        // Declared-but-absent: the module's info.json names a pack that the
        // running world doesn't expose. Log and skip with no transport call.
        if (!this.store.hasPackMetadata(packId)) {
            logger.warn(`[module:${systemId}] pack ${packId} not found in game.data.packs; skipping hydration.`);
            return 'missing';
        }

        const packFields = this.getPackFields(declaration);
        const entries = await this.getFreshnessIndex(declaration);
        if (!entries || !Array.isArray(entries)) {
            throw new Error(`Could not fetch freshness index for pack ${packId}.`);
        }

        const currentHash = this.computeHash(entries, declaration.hydrate || false);
        const existing = manifest.packs[packId];

        // Persistent manifest is authoritative: matching hash plus on-disk
        // shard means the pack is already current, no transport call needed.
        if (existing && existing.hash === currentHash) {
            const rows = await this.store.getPackRows(systemId, packId);
            if (rows) {
                logger.debug(`CompendiumService | Pack ${packId} is fresh (hash ${currentHash.substring(0, 8)}); skipping.`);
                return 'skipped';
            }
        }

        logger.info(`CompendiumService | Hydrating pack ${packId} (${declaration.hydrate ? 'FULL' : 'INDEX'})...`);

        let documents: Record<string, unknown>[] = [];

        if (declaration.hydrate) {
            const ids = entries
                .map((entry: unknown) => {
                    if (!entry || typeof entry !== 'object') return null;
                    const id = (entry as { _id?: unknown; id?: unknown })._id || (entry as { id?: unknown }).id;
                    return typeof id === 'string' ? id : null;
                })
                .filter((id): id is string => Boolean(id));

            const CHUNK_SIZE = 50;
            for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
                const chunk = ids.slice(i, i + CHUNK_SIZE);
                const response = await this.transport.emitSocketEvent<{ result?: Record<string, unknown>[] }>('modifyDocument', {
                    type: declaration.type,
                    action: 'get',
                    operation: {
                        pack: packId,
                        index: false,
                        ids: chunk,
                    },
                }, 5000);

                if (response?.result && Array.isArray(response.result)) {
                    documents = documents.concat(response.result);
                }
            }
        } else {
            documents = await this.getIndexedPackRows(declaration, entries, packFields);
        }

        await this.store.setPackRows(systemId, packId, documents);

        manifest.packs[packId] = {
            id: packId,
            hash: currentHash,
            lastUpdated: Date.now(),
            rowCount: documents.length,
            hydrate: declaration.hydrate,
            fields: declaration.fields,
        };

        return 'hydrated';
    }

    public async getPackEntries(packId: string, options: GetPackEntriesOptions = { index: true }): Promise<CompendiumIndexEntry[]> {
        const fetchEntries = async () => this.fetchPackEntries(packId, options);
        return this.transport.withHeartbeatPaused
            ? this.transport.withHeartbeatPaused(fetchEntries)
            : fetchEntries();
    }

    private async fetchPackEntries(packId: string, options: GetPackEntriesOptions): Promise<CompendiumIndexEntry[]> {
        logger.debug(`CompendiumService | Fetching entries for pack ${packId} (options: ${JSON.stringify(options)})...`);

        try {
            try {
                logger.debug(`[CompendiumService] [TRACE] getPackEntries Strategy 1 (modifyDocument): ${packId}`);
                const response = await this.transport.emitSocketEvent<unknown>('modifyDocument', {
                    type: inferDocumentType(packId),
                    action: 'get',
                    operation: {
                        pack: packId,
                        index: true,
                        fields: options.fields || [],
                    },
                }, 5000);
                const rows = responseArray<CompendiumIndexEntry>(response);
                if (rows) {
                    this.writeIndex(packId, rows, { fields: options.fields });
                    return rows;
                }
            } catch {
                // Preserve the existing socket ladder: failed probes fall through.
            }

            try {
                logger.debug(`[CompendiumService] [TRACE] getPackEntries Strategy 2 (getDocuments): ${packId}`);
                const response = await this.transport.emitSocketEvent<unknown>(
                    'getDocuments',
                    inferDocumentType(packId),
                    {
                        index: true,
                        pack: packId,
                        fields: options.fields || [],
                    },
                    5000,
                );
                const rows = responseArray<CompendiumIndexEntry>(response);
                if (rows) {
                    this.writeIndex(packId, rows, { fields: options.fields });
                    return rows;
                }
            } catch {
                // Preserve the existing socket ladder: failed probes fall through.
            }

            try {
                logger.debug(`[CompendiumService] [TRACE] getPackEntries Strategy 3 (getCompendiumIndex): ${packId}`);
                const response = await this.transport.emitSocketEvent<unknown>('getCompendiumIndex', packId, 5000);
                const rows = responseArray<CompendiumIndexEntry>(response);
                if (rows) {
                    this.writeIndex(packId, rows, { fields: options.fields });
                    return rows;
                }
            } catch {
                // Preserve the existing socket ladder: failed probes fall through.
            }

            logger.error(`CompendiumService | All entry fetch strategies failed for pack ${packId}`);
            return [];
        } catch (error) {
            logger.warn(`CompendiumService | getPackEntries failed for ${packId}: ${error}`);
            return [];
        }
    }

    public async getPackIndex(
        packId: string,
        type: string,
        options: CompendiumIndexOptions & { metadata?: CompendiumPackMetadata } = {},
    ): Promise<CompendiumIndexEntry[]> {
        try {
            logger.debug(`CompendiumService | Fetching index for pack ${packId} (type: ${type})...`);

            try {
                const response = await this.transport.emitSocketEvent<unknown>('getCompendiumIndex', packId, 3000);
                const rows = responseArray<CompendiumIndexEntry>(response);
                if (rows) {
                    this.writeIndex(packId, rows, options);
                    return rows;
                }
            } catch {
                // Preserve the existing socket ladder: failed probes fall through.
            }

            for (const t of typeFallbacks(type)) {
                try {
                    const response = await this.transport.emitSocketEvent<unknown>('getDocuments', {
                        type: t,
                        operation: {
                            pack: packId,
                            index: true,
                            ...(options.fields ? { fields: options.fields } : {}),
                        },
                    }, 2000);
                    const rows = responseArray<CompendiumIndexEntry>(response);
                    if (rows) {
                        this.writeIndex(packId, rows, options);
                        return rows;
                    }
                } catch {
                    // Try next type alias.
                }
            }

            try {
                const response = await this.transport.dispatchDocumentSocket(type, 'get', {
                    pack: packId,
                    index: true,
                    broadcast: false,
                    ...(options.fields ? { fields: options.fields } : {}),
                }, undefined, false);
                const rows = responseArray<CompendiumIndexEntry>(response) || [];
                if (rows.length > 0) {
                    this.writeIndex(packId, rows, options);
                    return rows;
                }
            } catch {
                // Ignore packData errors, matching the old CoreSocket behavior.
            }

            return [];
        } catch (error) {
            logger.warn(`CompendiumService | getPackIndex failed for ${packId}: ${error}`);
            return [];
        }
    }

    public async getPackDocuments(packId: string, type: string): Promise<unknown[]> {
        try {
            logger.debug(`CompendiumService | Fetching full documents for pack ${packId} (type: ${type})...`);

            for (const t of typeFallbacks(type, true)) {
                try {
                    const response = await this.transport.emitSocketEvent<unknown>('getDocuments', {
                        type: t,
                        operation: { pack: packId },
                    }, 5000);
                    const rows = responseArray(response);
                    if (rows) return rows;
                } catch {
                    // Try next type alias.
                }
            }

            try {
                const response = await this.transport.dispatchDocumentSocket(type, 'get', {
                    pack: packId,
                    broadcast: false,
                }, undefined, false);
                const rows = responseArray(response) || [];
                if (rows.length > 0) return rows;
            } catch {
                // Ignore errors, matching the old CoreSocket behavior.
            }

            return [];
        } catch (error) {
            logger.warn(`CompendiumService | getPackDocuments failed for ${packId}: ${error}`);
            return [];
        }
    }

    public async getPackDocument(
        packId: string,
        documentId: string,
        type?: string | null,
    ): Promise<Record<string, unknown> | null> {
        if (!this.transport.isConnected) return null;

        const trialTimeout = 500;
        for (const t of packDocumentTypes(type)) {
            if (!this.transport.isConnected) return null;

            try {
                logger.debug(`[CompendiumService] [TRACE] getPackDocument Strategy 1 (modifyDocument): ${packId} ${t} ${documentId}`);
                const response = await this.transport.emitSocketEvent<unknown>('modifyDocument', {
                    type: t,
                    action: 'get',
                    operation: { pack: packId, ids: [documentId] },
                }, trialTimeout);
                const found = findDocumentInResponse(response, documentId);
                if (found) return found;
            } catch {
                // Preserve the legacy fetchByUuid ladder: failed probes fall through.
            }

            try {
                logger.debug(`[CompendiumService] [TRACE] getPackDocument Strategy 2 (getDocuments): ${packId} ${t} ${documentId}`);
                const response = await this.transport.emitSocketEvent<unknown>('getDocuments', {
                    type: t,
                    operation: { pack: packId, ids: [documentId] },
                }, trialTimeout);
                const found = findDocumentInResponse(response, documentId);
                if (found) return found;
            } catch {
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
        const metadata = options.metadata || this.store.getPackMetadata(packId) || { id: packId, type: inferDocumentType(packId) };
        this.store.setPackIndex(packId, metadata, index, { fields: options.fields });
    }

    private getPackFields(declaration: CompendiumPackDeclaration): string[] {
        return normalizeFields(declaration.fields?.length ? declaration.fields : DEFAULT_INDEX_FIELDS);
    }

    private getDeclarationMetadata(declaration: CompendiumPackDeclaration): CompendiumPackMetadata {
        return this.store.getPackMetadata(declaration.id) || {
            id: declaration.id,
            type: declaration.type,
        };
    }

    private computeHash(entries: unknown[], hydrate: boolean): string {
        const signatureString = entries
            .map(entry => {
                if (!entry || typeof entry !== 'object') return '';
                const row = entry as { _id?: unknown; id?: unknown; name?: unknown };
                return `${row._id || row.id}-${row.name}`;
            })
            .concat(hydrate ? ['HYDRATED'] : ['INDEXED'])
            .sort()
            .join('|');
        return crypto.createHash('md5').update(signatureString).digest('hex');
    }

    private async getFreshnessIndex(declaration: CompendiumPackDeclaration): Promise<unknown[]> {
        const cachedDefault = this.store.getPackIndex(declaration.id);
        if (cachedDefault && hasFreshnessInputs(cachedDefault)) {
            return cachedDefault;
        }

        const fetched = await this.getPackEntries(declaration.id, { index: true });
        if (Array.isArray(fetched)) {
            this.store.setPackIndex(
                declaration.id,
                this.getDeclarationMetadata(declaration),
                fetched as CompendiumIndexEntry[],
            );
        }
        return fetched;
    }

    private async getIndexedPackRows(
        declaration: CompendiumPackDeclaration,
        defaultIndex: unknown[],
        packFields: readonly string[],
    ): Promise<Record<string, unknown>[]> {
        // The freshness hash only needs the default id/name index. Pack rows
        // may need extra module-declared fields, so fetch a field-aware
        // variant only when the default index does not already contain them.
        if (indexCoversFields(defaultIndex, packFields)) {
            return defaultIndex as Record<string, unknown>[];
        }

        const cachedVariant = this.store.getPackIndex(declaration.id, { fields: packFields });
        if (cachedVariant && indexCoversFields(cachedVariant, packFields)) {
            return cachedVariant as Record<string, unknown>[];
        }

        const fetched = await this.getPackEntries(declaration.id, {
            index: true,
            fields: packFields,
        }) as CompendiumIndexEntry[] || [];

        this.store.setPackIndex(
            declaration.id,
            this.getDeclarationMetadata(declaration),
            fetched,
            { fields: packFields },
        );
        return fetched as Record<string, unknown>[];
    }
}
