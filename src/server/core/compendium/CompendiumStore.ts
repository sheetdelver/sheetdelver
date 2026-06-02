import { persistentCache } from '@server/core/cache/PersistentCache';
import { cloneDocument } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import type {
    CompendiumDiscoveryResult,
    CompendiumIndexEntry,
    CompendiumIndexLookupResult,
    CompendiumIndexOptions,
    CompendiumIndexVariant,
    CompendiumPackCache,
    CompendiumPackDocument,
    CompendiumPackIndexSnapshot,
    CompendiumPackManifest,
    CompendiumPackMetadata,
    CompendiumPackQueryOptions,
    GameDataPackEnvelope,
} from './types';

const DEFAULT_FIELD_KEY = 'default';

interface StoredPack {
    metadata: CompendiumPackMetadata;
    variants: Map<string, CompendiumIndexVariant>;
}

function cloneOrNull<T>(value: T | null | undefined): T | null {
    return value == null ? null : cloneDocument(value);
}

function normalizeFields(fields?: readonly string[] | null): string[] | null {
    if (!fields || fields.length === 0) return null;
    const normalized = Array.from(new Set(
        fields
            .map(field => String(field).trim())
            .filter(Boolean)
    )).sort();
    return normalized.length === 0 ? null : normalized;
}

function fieldKeyFor(fields?: readonly string[] | null): string {
    const normalized = normalizeFields(fields);
    return normalized ? `fields:${normalized.join('|')}` : DEFAULT_FIELD_KEY;
}

function getDocumentId(entry: CompendiumIndexEntry): string | null {
    return entry._id || entry.id || null;
}

function getRowDocumentId(document: CompendiumPackDocument): string | null {
    const id = document._id || document.id;
    return typeof id === 'string' ? id : null;
}

function matchesDocumentId(document: CompendiumPackDocument, documentId: string): boolean {
    const id = getRowDocumentId(document);
    if (id === documentId) return true;

    const uuid = document.uuid;
    return typeof uuid === 'string' && (uuid === documentId || uuid.endsWith(`.${documentId}`));
}

function getPathValue(document: CompendiumPackDocument, path: string): unknown {
    if (Object.prototype.hasOwnProperty.call(document, path)) return document[path];

    return path.split('.').reduce<unknown>((current, segment) => {
        if (!current || typeof current !== 'object') return undefined;
        return (current as Record<string, unknown>)[segment];
    }, document);
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
    if (actual === expected) return true;
    if (actual == null || expected == null) return false;
    if (typeof actual !== 'object' && typeof expected !== 'object') return String(actual) === String(expected);
    return JSON.stringify(actual) === JSON.stringify(expected);
}

function matchesQuery(document: CompendiumPackDocument, query: Record<string, unknown> = {}): boolean {
    for (const [key, expected] of Object.entries(query)) {
        if (key === '_id' || key === 'id') {
            const id = getRowDocumentId(document);
            if (id === String(expected)) continue;
        }

        if (!valuesEqual(getPathValue(document, key), expected)) return false;
    }

    return true;
}

function parseCompendiumUuid(uuid: string): { packId: string; documentId: string; type: string | null } | null {
    if (!uuid.startsWith('Compendium.')) return null;
    const parts = uuid.split('.');
    if (parts.length < 4) return null;

    const documentId = parts.pop();
    if (!documentId) return null;

    const possibleType = parts[parts.length - 1] || '';
    const hasTypeSegment = /^[A-Z]/.test(possibleType);
    const type = hasTypeSegment ? possibleType : null;
    const packParts = hasTypeSegment ? parts.slice(1, -1) : parts.slice(1);
    const packId = packParts.join('.');
    if (!packId) return null;

    return { packId, documentId, type };
}

// Compendium backing lives under a `compendiums/` sub-namespace of the module's cache
// dir (ADR-0027 decision 13), a sibling of the DataStore's `datastore/` boundary, so the
// two never collide and `DataStore.keys()` cannot observe pack shards or the manifest.
const COMPENDIUM_NS = 'compendiums';
function packNamespaceFor(systemId: string): string {
    return `${systemId}/${COMPENDIUM_NS}`;
}

function manifestKeyFor(systemId: string): string {
    return `manifest-${systemId}`;
}

function shardKeyFor(packId: string): string {
    // Preserve the key shape CompendiumPackSyncService has written historically.
    return `pack-${packId.replace('.', '-')}`;
}

function stableShardKeyFor(packId: string): string {
    return `pack-${packId.replace(/\./g, '-')}`;
}

function getPackId(pack: CompendiumPackMetadata, systemId?: string | null): string | null {
    const explicit = pack.id || pack._id;
    if (typeof explicit === 'string' && explicit) return explicit;
    const moduleId = typeof pack.moduleId === 'string' ? pack.moduleId : null;
    const name = typeof pack.name === 'string' ? pack.name : null;
    if (moduleId && name) return `${moduleId}.${name}`;
    if (name) return `${systemId || 'system'}.${name}`;
    return null;
}

/**
 * Unified read-only store for compendium pack state.
 *
 * Two surfaces, one owner:
 *
 *  - **In-memory** (synchronous): pre-filed pack metadata seeded from
 *    `game.data.packs`, plus per-pack index variants used by name/index
 *    lookups. Cleared by `clear(reason)` on world close / restart / world
 *    change. Never holds documents.
 *
 *  - **Persistent** (async via `PersistentCache`): per-pack shards of declared
 *    rows or full documents, plus the per-system manifest used for freshness
 *    detection. Survives transient disconnects and restarts; only an
 *    operator-driven reset or world identity change evicts shards.
 *
 * The store has no `upsert` / `patch` / `delete` for compendium documents.
 * Pack contents are owned upstream by Foundry; the platform mirrors only the
 * slice modules declared.
 */
export class CompendiumStore {
    private packs = new Map<string, StoredPack>();

    public constructor(private readonly cache: CompendiumPackCache = persistentCache) { }

    /**
     * Discards in-memory state only.
     *
     * Per ADR-0021, `clear(reason)` drops the in-memory pre-filed metadata
     * and any cached index variants held by this instance. It must NOT
     * delete persistent shards or the manifest — a transient service-account
     * disconnect or world close should not wipe the on-disk warm cache.
     * Persistent shards are reused on reconnect when world identity matches
     * and the manifest hash is current; explicit eviction is reserved for
     * operator action or world identity change.
     */
    public clear(_reason?: string): void {
        this.packs.clear();
    }

    public isReady(): boolean {
        return this.packs.size > 0;
    }

    /**
     * Passive seed from the bootstrap envelope.
     *
     * Per ADR-0021, this records which packs exist (id, document type,
     * package source, label, etc.) WITHOUT issuing any transport calls.
     * `game.data.packs` is a manifest of packs, not document data — see the
     * ADR's "What `game.data.packs` does and does not carry" section.
     *
     * Hydration of index rows or full documents is module-driven via
     * `CompendiumService.hydratePack(...)`; this method must not call any
     * Foundry socket API.
     */
    public seedPackMetadataFromGameData(gameData: GameDataPackEnvelope | null | undefined, _reason?: string): void {
        if (!gameData) return;

        const systemId = gameData.system?.id;
        const seen = new Set<string>();
        const sources: Array<{ source: string; packs: CompendiumPackMetadata[] | undefined }> = [
            { source: 'game.packs', packs: gameData.packs },
            { source: 'world', packs: gameData.world?.packs },
            { source: 'system', packs: gameData.system?.packs },
        ];

        if (Array.isArray(gameData.modules)) {
            for (const gameModule of gameData.modules) {
                if (!gameModule?.packs?.length) continue;
                sources.push({
                    source: 'module',
                    packs: gameModule.packs.map(pack => ({
                        ...pack,
                        moduleId: pack.moduleId || gameModule.id,
                        packageName: pack.packageName || gameModule.id,
                    } as CompendiumPackMetadata)),
                });
            }
        }

        for (const { source, packs } of sources) {
            if (!Array.isArray(packs)) continue;
            for (const pack of packs) {
                const id = getPackId(pack, systemId);
                if (!id || seen.has(id)) continue;
                seen.add(id);
                this.setPackMetadata(id, { ...pack, id, source: pack.source || source });
            }
        }
    }

    public setPackMetadata(packId: string, metadata: CompendiumPackMetadata): void {
        const id = String(packId || '').trim();
        if (!id) throw new Error('CompendiumStore.setPackMetadata requires a pack id');

        const existing = this.packs.get(id);
        const stored: StoredPack = existing || {
            metadata: { ...cloneDocument(metadata), id },
            variants: new Map<string, CompendiumIndexVariant>(),
        };
        stored.metadata = { ...cloneDocument(stored.metadata), ...cloneDocument(metadata), id };
        this.packs.set(id, stored);
    }

    public seedDiscoveredPacks(results: CompendiumDiscoveryResult[], _reason?: string): void {
        this.clear(_reason);
        for (const result of results) {
            this.setPackIndex(result.id, result.metadata, result.index, { fields: result.fields });
        }
    }

    public setPackIndex(
        packId: string,
        metadata: CompendiumPackMetadata,
        index: CompendiumIndexEntry[],
        options: CompendiumIndexOptions & { updatedAt?: number } = {},
    ): void {
        const id = String(packId || '').trim();
        if (!id) throw new Error('CompendiumStore.setPackIndex requires a pack id');

        const fields = normalizeFields(options.fields);
        const fieldKey = fieldKeyFor(fields);
        const existing = this.packs.get(id);
        const stored: StoredPack = existing || {
            metadata: { ...cloneDocument(metadata), id },
            variants: new Map<string, CompendiumIndexVariant>(),
        };

        stored.metadata = { ...cloneDocument(stored.metadata), ...cloneDocument(metadata), id };
        stored.variants.set(fieldKey, {
            fieldKey,
            fields: fields ? [...fields] : null,
            index: cloneDocument(index || []),
            updatedAt: options.updatedAt ?? Date.now(),
        });
        this.packs.set(id, stored);
    }

    public getPackIndex(packId: string, options: CompendiumIndexOptions = {}): CompendiumIndexEntry[] | null {
        const variant = this.getVariant(packId, options);
        return cloneOrNull(variant?.index);
    }

    public getPackMetadata(packId: string): CompendiumPackMetadata | null {
        return cloneOrNull(this.packs.get(packId)?.metadata);
    }

    public listPackIndices(options: CompendiumIndexOptions = {}): CompendiumPackIndexSnapshot[] {
        const snapshots: CompendiumPackIndexSnapshot[] = [];
        for (const [id, pack] of this.packs.entries()) {
            const variant = this.getVariant(id, options);
            if (!variant) continue;
            snapshots.push({
                id,
                metadata: cloneDocument(pack.metadata),
                variant: cloneDocument(variant),
            });
        }
        return snapshots;
    }

    public listPackMetadata(): CompendiumPackMetadata[] {
        return Array.from(this.packs.values()).map(pack => cloneDocument(pack.metadata));
    }

    public hasPackMetadata(packId: string): boolean {
        return this.packs.has(packId);
    }

    public findIndexEntry(uuid: string): CompendiumIndexLookupResult | null {
        const parsed = parseCompendiumUuid(uuid);
        if (!parsed) return null;

        const pack = this.packs.get(parsed.packId);
        if (!pack) return null;

        const variants = [
            pack.variants.get(DEFAULT_FIELD_KEY),
            ...Array.from(pack.variants.values()).filter(variant => variant.fieldKey !== DEFAULT_FIELD_KEY),
        ].filter((variant): variant is CompendiumIndexVariant => Boolean(variant));

        for (const variant of variants) {
            const entry = variant.index.find(candidate => {
                const id = getDocumentId(candidate);
                if (id === parsed.documentId) return true;
                return typeof candidate.uuid === 'string' && candidate.uuid === uuid;
            });
            if (!entry) continue;

            return {
                packId: parsed.packId,
                documentId: parsed.documentId,
                type: parsed.type,
                metadata: cloneDocument(pack.metadata),
                entry: cloneDocument(entry),
                fieldKey: variant.fieldKey,
            };
        }

        return null;
    }

    // ── Persistent tier ────────────────────────────────────────────────────────
    //
    // Per-pack shards keyed by `(<systemId>/compendiums, "pack-<packId>")` and a
    // per-system manifest. Shard key shape is preserved from the previous
    // CompendiumPackStore; the `compendiums/` sub-namespace (ADR-0027 decision 13)
    // isolates backing from DataStore. Shards re-hydrate from `game.data` on
    // bootstrap, so the namespace move needs no migration — stale flat-layout files
    // from before the move are simply left orphaned and re-seeded under the new path.

    public async getManifest(systemId: string): Promise<CompendiumPackManifest | null> {
        return this.cache.get<CompendiumPackManifest>(packNamespaceFor(systemId), manifestKeyFor(systemId));
    }

    public async setManifest(manifest: CompendiumPackManifest): Promise<void> {
        await this.cache.set(packNamespaceFor(manifest.systemId), manifestKeyFor(manifest.systemId), manifest);
    }

    public async getPackRows(systemId: string, packId: string): Promise<CompendiumPackDocument[] | null> {
        const ns = packNamespaceFor(systemId);
        const legacy = await this.cache.get<CompendiumPackDocument[]>(ns, shardKeyFor(packId));
        if (Array.isArray(legacy)) return legacy;

        const stable = stableShardKeyFor(packId);
        if (stable === shardKeyFor(packId)) return null;
        const fallback = await this.cache.get<CompendiumPackDocument[]>(ns, stable);
        return Array.isArray(fallback) ? fallback : null;
    }

    public async setPackRows(systemId: string, packId: string, documents: CompendiumPackDocument[]): Promise<void> {
        await this.cache.set(packNamespaceFor(systemId), shardKeyFor(packId), documents);
    }

    public async findAll(
        systemId: string,
        _type: string,
        query: Record<string, unknown> = {},
        options: CompendiumPackQueryOptions = {},
    ): Promise<CompendiumPackDocument[]> {
        const packIds = await this.resolvePackIds(systemId, options.packIds);
        if (packIds.length === 0) return [];

        const results: CompendiumPackDocument[] = [];
        for (const packId of packIds) {
            const rows = await this.getPackRows(systemId, packId);
            if (!rows) continue;
            results.push(...rows.filter(document => matchesQuery(document, query)));
        }

        return results;
    }

    public async findOne(
        systemId: string,
        type: string,
        query: Record<string, unknown>,
        options: CompendiumPackQueryOptions = {},
    ): Promise<CompendiumPackDocument | null> {
        const results = await this.findAll(systemId, type, query, options);
        return results[0] || null;
    }

    public async getById(
        systemId: string,
        type: string,
        id: string,
        options: CompendiumPackQueryOptions = {},
    ): Promise<CompendiumPackDocument | null> {
        const byUnderscoreId = await this.findOne(systemId, type, { _id: id }, options);
        if (byUnderscoreId) return byUnderscoreId;

        const byId = await this.findOne(systemId, type, { id }, options);
        if (byId) return byId;

        return this.findOne(systemId, type, { uuid: id }, options);
    }

    public async findDocument(
        systemId: string,
        packId: string,
        documentId: string,
        _type?: string | null,
    ): Promise<CompendiumPackDocument | null> {
        const rows = await this.getPackRows(systemId, packId);
        if (!rows) return null;

        // Pack scope tells us the root document type. Row `type` can be an item
        // subtype in hydrated Item packs, so do not filter on it here.
        return rows.find(document => matchesDocumentId(document, documentId)) || null;
    }

    private async resolvePackIds(systemId: string, packIds?: readonly string[] | null): Promise<string[]> {
        if (packIds) return Array.from(new Set(packIds));

        const manifest = await this.getManifest(systemId);
        if (!manifest) return [];
        return Object.keys(manifest.packs || {});
    }

    private getVariant(packId: string, options: CompendiumIndexOptions = {}): CompendiumIndexVariant | null {
        const pack = this.packs.get(packId);
        if (!pack) return null;
        const fieldKey = fieldKeyFor(options.fields);
        return pack.variants.get(fieldKey) || null;
    }
}

export const compendiumStore = new CompendiumStore();
