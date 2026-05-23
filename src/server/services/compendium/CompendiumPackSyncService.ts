import { logger } from '@shared/utils/logger';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { CompendiumStore, compendiumStore } from '@server/core/compendium/CompendiumStore';
import { compendiumPackStore, type CompendiumPackStore } from '@server/core/compendium/CompendiumPackStore';
import type { CompendiumPackConfig, CompendiumPackDeclaration } from '@shared/sdk';
import type { CompendiumIndexEntry, CompendiumPackMetadata, CompendiumPackManifest } from '@server/core/compendium/types';
import crypto from 'node:crypto';

export interface CompendiumPackSyncClient {
    emitSocketEvent<T>(event: string, ...payloads: unknown[]): Promise<T>;
}

export interface CompendiumPackIndexReader {
    getPackEntries(packId: string, options?: { index?: boolean; fields?: readonly string[] }): Promise<unknown[]>;
}

export interface CompendiumPackSyncServiceDeps {
    packStore?: CompendiumPackStore;
    compendiumStore?: CompendiumStore;
}

const DEFAULT_INDEX_FIELDS = ['name', 'img', 'type'] as const;

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

export class CompendiumPackSyncService {
    private static instance: CompendiumPackSyncService;
    private readonly packStore: CompendiumPackStore;
    private readonly compendiumStore: CompendiumStore;

    public constructor(deps: CompendiumPackSyncServiceDeps = {}) {
        this.packStore = deps.packStore || compendiumPackStore;
        this.compendiumStore = deps.compendiumStore || compendiumStore;
    }

    public static getInstance(): CompendiumPackSyncService {
        if (!CompendiumPackSyncService.instance) {
            CompendiumPackSyncService.instance = new CompendiumPackSyncService();
        }
        return CompendiumPackSyncService.instance;
    }

    /**
     * Synchronize module-declared compendium packs with the local pack-row cache.
     *
     * ADR-0015 Phase 4 keeps the existing freshness/hash behavior intact while
     * allowing Pathway B to reuse Pathway A's default index for freshness and
     * fetch field-aware variants only when refreshed pack rows need them.
     */
    public async sync(
        client: CompendiumPackSyncClient,
        systemId: string,
        config: CompendiumPackConfig,
        packReader: CompendiumPackIndexReader,
    ): Promise<CompendiumPackManifest> {
        logger.info(`CompendiumPackSyncService | Starting sync for system: ${systemId}...`);

        const existingManifest = await this.packStore.getManifest(systemId) || {
            systemId,
            packs: {},
            _instanceId: crypto.randomUUID(),
        };

        const newManifest: CompendiumPackManifest = {
            ...existingManifest,
            packs: { ...existingManifest.packs },
        };

        let updatedCount = 0;

        for (const packConfig of config.packs) {
            try {
                const refreshed = await this.syncPack(client, packReader, systemId, packConfig, newManifest);
                if (refreshed) updatedCount++;
            } catch (err: unknown) {
                logger.error(`CompendiumPackSyncService | Failed to sync pack ${packConfig.id}: ${getErrorMessage(err)}`);
            }
        }

        if (updatedCount > 0) {
            await this.packStore.setManifest(newManifest);
            logger.info(`CompendiumPackSyncService | Sync complete for ${systemId}. ${updatedCount} packs updated.`);
        } else {
            logger.info(`CompendiumPackSyncService | Sync complete for ${systemId}. All packs up to date.`);
        }

        return newManifest;
    }

    private async syncPack(
        client: CompendiumPackSyncClient,
        packReader: CompendiumPackIndexReader,
        systemId: string,
        packConfig: CompendiumPackDeclaration,
        manifest: CompendiumPackManifest,
    ): Promise<boolean> {
        const packId = packConfig.id;

        const packFields = this.getPackFields(packConfig);
        const entries = await this.getFreshnessIndex(packReader, packConfig);
        if (!entries || !Array.isArray(entries)) {
            throw new Error(`Could not find pack ${packId} in Foundry or result was not an array.`);
        }

        const currentHash = this.computeHash(entries, packConfig.hydrate || false);
        const existing = manifest.packs[packId];

        if (existing && existing.hash === currentHash) {
            const rowsExist = await this.packStore.getPackRows(systemId, packId);
            if (rowsExist) {
                logger.debug(`CompendiumPackSyncService | Pack ${packId} is up to date (Hash: ${currentHash.substring(0, 8)})`);
                return false;
            }
        }

        logger.info(`CompendiumPackSyncService | Syncing stale pack: ${packId} (${packConfig.hydrate ? 'FULL HYDRATION' : 'INDEXED'})...`);

        let documents: Record<string, unknown>[] = [];

        if (packConfig.hydrate) {
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
                const response = await client.emitSocketEvent<{ result?: Record<string, unknown>[] }>('modifyDocument', {
                    type: packConfig.type,
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
            documents = await this.getIndexedPackRows(packReader, packConfig, entries, packFields);
        }

        await this.packStore.setPackRows(systemId, packId, documents);

        manifest.packs[packId] = {
            id: packId,
            hash: currentHash,
            lastUpdated: Date.now(),
            rowCount: documents.length,
            hydrate: packConfig.hydrate,
            fields: packConfig.fields,
        };

        return true;
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

    private getPackFields(packConfig: CompendiumPackDeclaration): string[] {
        return normalizeFields(packConfig.fields?.length ? packConfig.fields : DEFAULT_INDEX_FIELDS);
    }

    private getPackMetadata(packConfig: CompendiumPackDeclaration): CompendiumPackMetadata {
        return this.compendiumStore.getPackMetadata(packConfig.id) || {
            id: packConfig.id,
            type: packConfig.type,
        };
    }

    private async getFreshnessIndex(
        packReader: CompendiumPackIndexReader,
        packConfig: CompendiumPackDeclaration,
    ): Promise<unknown[]> {
        const cachedDefault = this.compendiumStore.getPackIndex(packConfig.id);
        if (cachedDefault && hasFreshnessInputs(cachedDefault)) {
            return cachedDefault;
        }

        const fetched = await packReader.getPackEntries(packConfig.id, { index: true });
        if (Array.isArray(fetched)) {
            this.compendiumStore.setPackIndex(
                packConfig.id,
                this.getPackMetadata(packConfig),
                fetched as CompendiumIndexEntry[],
            );
        }
        return fetched;
    }

    private async getIndexedPackRows(
        packReader: CompendiumPackIndexReader,
        packConfig: CompendiumPackDeclaration,
        defaultIndex: unknown[],
        packFields: readonly string[],
    ): Promise<Record<string, unknown>[]> {
        // The freshness hash above only needs the default id/name index. Pack
        // rows may need extra module-declared fields, so fetch a field-aware
        // variant only when the default index does not already contain them.
        if (indexCoversFields(defaultIndex, packFields)) {
            return defaultIndex as Record<string, unknown>[];
        }

        const cachedVariant = this.compendiumStore.getPackIndex(packConfig.id, { fields: packFields });
        if (cachedVariant && indexCoversFields(cachedVariant, packFields)) {
            return cachedVariant as Record<string, unknown>[];
        }

        const fetched = await packReader.getPackEntries(packConfig.id, {
            index: true,
            fields: packFields,
        }) as CompendiumIndexEntry[] || [];

        this.compendiumStore.setPackIndex(
            packConfig.id,
            this.getPackMetadata(packConfig),
            fetched,
            { fields: packFields },
        );
        return fetched as Record<string, unknown>[];
    }
}

export const compendiumPackSyncService = CompendiumPackSyncService.getInstance();
