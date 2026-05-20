import { persistentCache } from '@server/core/cache/PersistentCache';
import type { DiscoveryShardManifest } from './types';

export interface DiscoveryShardCache {
    get<T>(namespace: string, key: string): Promise<T | null>;
    set<T>(namespace: string, key: string, value: T): Promise<void>;
}

export interface DiscoveryShardQueryOptions {
    packIds?: readonly string[] | null;
}

export type DiscoveryShardDocument = Record<string, unknown>;

function manifestKeyFor(systemId: string): string {
    return `manifest-${systemId}`;
}

function shardKeyFor(packId: string): string {
    // Preserve the key shape DiscoveryService has written historically.
    return `pack-${packId.replace('.', '-')}`;
}

function stableShardKeyFor(packId: string): string {
    return `pack-${packId.replace(/\./g, '-')}`;
}

function getDocumentId(document: DiscoveryShardDocument): string | null {
    const id = document._id || document.id;
    return typeof id === 'string' ? id : null;
}

function matchesDocumentId(document: DiscoveryShardDocument, documentId: string): boolean {
    const id = getDocumentId(document);
    if (id === documentId) return true;

    const uuid = document.uuid;
    return typeof uuid === 'string' && (uuid === documentId || uuid.endsWith(`.${documentId}`));
}

function getPathValue(document: DiscoveryShardDocument, path: string): unknown {
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

function matchesQuery(document: DiscoveryShardDocument, query: Record<string, unknown> = {}): boolean {
    for (const [key, expected] of Object.entries(query)) {
        if (key === '_id' || key === 'id') {
            const id = getDocumentId(document);
            if (id === String(expected)) continue;
        }

        if (!valuesEqual(getPathValue(document, key), expected)) return false;
    }

    return true;
}

/**
 * ADR-0015 Phase 3 read/write boundary for module-declared discovery shards.
 *
 * DiscoveryService writes these persistent shards during bootstrap. This Store
 * gives `context.platform.discovery` a supported read model without exposing
 * the raw PersistentCache namespace to modules.
 */
export class DiscoveryShardStore {
    public constructor(private readonly cache: DiscoveryShardCache = persistentCache) { }

    public async getManifest(systemId: string): Promise<DiscoveryShardManifest | null> {
        return this.cache.get<DiscoveryShardManifest>(systemId, manifestKeyFor(systemId));
    }

    public async setManifest(manifest: DiscoveryShardManifest): Promise<void> {
        await this.cache.set(manifest.systemId, manifestKeyFor(manifest.systemId), manifest);
    }

    public async getShard(systemId: string, packId: string): Promise<DiscoveryShardDocument[] | null> {
        const legacy = await this.cache.get<DiscoveryShardDocument[]>(systemId, shardKeyFor(packId));
        if (Array.isArray(legacy)) return legacy;

        const stable = stableShardKeyFor(packId);
        if (stable === shardKeyFor(packId)) return null;
        const fallback = await this.cache.get<DiscoveryShardDocument[]>(systemId, stable);
        return Array.isArray(fallback) ? fallback : null;
    }

    public async setShard(systemId: string, packId: string, documents: DiscoveryShardDocument[]): Promise<void> {
        await this.cache.set(systemId, shardKeyFor(packId), documents);
    }

    public async findAll(
        systemId: string,
        _type: string,
        query: Record<string, unknown> = {},
        options: DiscoveryShardQueryOptions = {},
    ): Promise<DiscoveryShardDocument[]> {
        const packIds = await this.resolvePackIds(systemId, options.packIds);
        if (packIds.length === 0) return [];

        const results: DiscoveryShardDocument[] = [];
        for (const packId of packIds) {
            const shard = await this.getShard(systemId, packId);
            if (!shard) continue;
            results.push(...shard.filter(document => matchesQuery(document, query)));
        }

        return results;
    }

    public async findOne(
        systemId: string,
        type: string,
        query: Record<string, unknown>,
        options: DiscoveryShardQueryOptions = {},
    ): Promise<DiscoveryShardDocument | null> {
        const results = await this.findAll(systemId, type, query, options);
        return results[0] || null;
    }

    public async getById(
        systemId: string,
        type: string,
        id: string,
        options: DiscoveryShardQueryOptions = {},
    ): Promise<DiscoveryShardDocument | null> {
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
    ): Promise<DiscoveryShardDocument | null> {
        const shard = await this.getShard(systemId, packId);
        if (!shard) return null;

        // Pack scope tells us the root document type. Row `type` can be an item
        // subtype in hydrated Item packs, so do not filter on it here.
        return shard.find(document => matchesDocumentId(document, documentId)) || null;
    }

    private async resolvePackIds(systemId: string, packIds?: readonly string[] | null): Promise<string[]> {
        if (packIds) return Array.from(new Set(packIds));

        const manifest = await this.getManifest(systemId);
        if (!manifest) return [];
        return Object.keys(manifest.packs || {});
    }
}

export const discoveryShardStore = new DiscoveryShardStore();
