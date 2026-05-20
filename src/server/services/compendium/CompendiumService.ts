import { logger } from '@shared/utils/logger';
import { compendiumStore, CompendiumStore } from '@server/core/compendium/CompendiumStore';
import type {
    CompendiumDiscoveryResult,
    CompendiumIndexEntry,
    CompendiumIndexOptions,
    CompendiumPackMetadata,
} from '@server/core/compendium/types';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import type { GameData, FoundryPackManifest } from '@server/core/world/types';

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
    getGameDataSnapshot?: () => GameData | null;
}

export interface DiscoverIndicesOptions {
    onlyGamePacks?: boolean;
    forceRefresh?: boolean;
}

export interface GetPackEntriesOptions extends CompendiumIndexOptions {
    index?: boolean;
}

const CORE_PACK_DOCUMENT_TYPES = ['Item', 'Actor', 'JournalEntry', 'RollTable', 'Scene', 'Macro', 'Playlist'] as const;
const DEFAULT_PACK_DOCUMENT_TYPES = ['Item', 'Actor', 'JournalEntry', 'RollTable'] as const;

function responseArray<T = unknown>(response: unknown): T[] | null {
    if (Array.isArray(response)) return response as T[];
    if (response && typeof response === 'object' && Array.isArray((response as { result?: unknown }).result)) {
        return (response as { result: T[] }).result;
    }
    return null;
}

function getPackId(pack: FoundryPackManifest & { moduleId?: string }, game: GameData): string | null {
    const id = pack.id || (pack as { _id?: string })._id;
    if (id) return id;
    if (pack.moduleId && pack.name) return `${pack.moduleId}.${pack.name}`;
    if (pack.name) return `${game.system?.id || 'system'}.${pack.name}`;
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

function snapshotToDiscoveryResult(snapshot: ReturnType<CompendiumStore['listPackIndices']>[number]): CompendiumDiscoveryResult {
    return {
        id: snapshot.id,
        metadata: snapshot.metadata,
        index: snapshot.variant.index,
        fields: snapshot.variant.fields,
    };
}

/**
 * ADR-0015 Phase 2 service for Pathway A compendium reads.
 *
 * The service owns the compatibility ladders that used to live directly on
 * CoreSocket, but it deliberately depends on a tiny transport shape. That keeps
 * compendium behavior from growing new dependencies on socket lifecycle state
 * while ADR-0017 decides where heartbeat/engagement policy ultimately belongs.
 */
export class CompendiumService {
    private readonly transport: CompendiumTransport;
    private readonly store: CompendiumStore;
    private readonly getGameDataSnapshot: () => GameData | null;

    public constructor(deps: CompendiumServiceDeps) {
        this.transport = deps.transport;
        this.store = deps.store || compendiumStore;
        this.getGameDataSnapshot = deps.getGameDataSnapshot || (() => worldStateStore.getGameDataSnapshot());
    }

    public async discoverIndices(options: DiscoverIndicesOptions = {}): Promise<CompendiumDiscoveryResult[]> {
        if (!this.transport.isConnected) return [];

        const cached = this.store.listPackIndices();
        if (!options.forceRefresh && !options.onlyGamePacks && cached.length > 0) {
            return cached.map(snapshotToDiscoveryResult);
        }

        try {
            const game = this.getGameDataSnapshot();
            if (!game) {
                logger.warn('CompendiumService | No gameData available for discovery.');
                return [];
            }

            const packs = new Map<string, CompendiumPackMetadata>();

            if (Array.isArray(game.packs)) {
                for (const pack of game.packs) {
                    const id = getPackId(pack, game);
                    if (id) packs.set(id, { ...pack, id, source: 'game.packs' });
                }
            }

            if (!options.onlyGamePacks) {
                const worldPacks = game.world?.packs || [];
                const systemPacks = game.system?.packs || [];
                const modulePacks = Array.isArray(game.modules)
                    ? game.modules.flatMap(module =>
                        (module.packs || []).map(pack => ({ ...pack, moduleId: module.id, packageName: module.id }))
                    )
                    : [];

                const fallbackPacks = [
                    ...worldPacks.map(pack => ({ ...pack, source: 'world' })),
                    ...systemPacks.map(pack => ({ ...pack, source: 'system' })),
                    ...modulePacks.map(pack => ({ ...pack, source: 'module' })),
                ];

                for (const pack of fallbackPacks) {
                    const id = getPackId(pack, game);
                    if (id && !packs.has(id)) packs.set(id, { ...pack, id });
                }
            }

            logger.info(`CompendiumService | Discovering indices for ${packs.size} packs in parallel...`);
            const results = await Promise.all(Array.from(packs.entries()).map(async ([packId, metadata]) => {
                const type = inferDocumentType(packId, metadata);
                const index = await this.getPackIndex(packId, type, { metadata });
                return { id: packId, metadata, index };
            }));

            this.store.seedDiscoveredPacks(results, 'pathway-a-discovery');
            logger.info(`CompendiumService | Compendium discovery complete (${results.length} packs indexed)`);
            return results;
        } catch (error) {
            logger.warn(`CompendiumService | discoverIndices failed: ${error}`);
            return [];
        }
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
}
