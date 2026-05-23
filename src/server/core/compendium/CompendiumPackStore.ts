import { persistentCache } from '@server/core/cache/PersistentCache';
import type { CompendiumPackManifest } from './types';

export interface CompendiumPackCache {
    get<T>(namespace: string, key: string): Promise<T | null>;
    set<T>(namespace: string, key: string, value: T): Promise<void>;
}

export interface CompendiumPackQueryOptions {
    packIds?: readonly string[] | null;
}

export type CompendiumPackDocument = Record<string, unknown>;

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

function getDocumentId(document: CompendiumPackDocument): string | null {
    const id = document._id || document.id;
    return typeof id === 'string' ? id : null;
}

function matchesDocumentId(document: CompendiumPackDocument, documentId: string): boolean {
    const id = getDocumentId(document);
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
            const id = getDocumentId(document);
            if (id === String(expected)) continue;
        }

        if (!valuesEqual(getPathValue(document, key), expected)) return false;
    }

    return true;
}

/**
 * Read/write boundary for module-declared compendium pack rows.
 *
 * CompendiumPackSyncService writes these persistent rows during bootstrap. This Store
 * gives `context.platform.compendiumPacks` a supported read model without exposing
 * the raw PersistentCache namespace to modules.
 */
export class CompendiumPackStore {
    public constructor(private readonly cache: CompendiumPackCache = persistentCache) { }

    public async getManifest(systemId: string): Promise<CompendiumPackManifest | null> {
        return this.cache.get<CompendiumPackManifest>(systemId, manifestKeyFor(systemId));
    }

    public async setManifest(manifest: CompendiumPackManifest): Promise<void> {
        await this.cache.set(manifest.systemId, manifestKeyFor(manifest.systemId), manifest);
    }

    public async getPackRows(systemId: string, packId: string): Promise<CompendiumPackDocument[] | null> {
        const legacy = await this.cache.get<CompendiumPackDocument[]>(systemId, shardKeyFor(packId));
        if (Array.isArray(legacy)) return legacy;

        const stable = stableShardKeyFor(packId);
        if (stable === shardKeyFor(packId)) return null;
        const fallback = await this.cache.get<CompendiumPackDocument[]>(systemId, stable);
        return Array.isArray(fallback) ? fallback : null;
    }

    public async setPackRows(systemId: string, packId: string, documents: CompendiumPackDocument[]): Promise<void> {
        await this.cache.set(systemId, shardKeyFor(packId), documents);
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
}

export const compendiumPackStore = new CompendiumPackStore();
