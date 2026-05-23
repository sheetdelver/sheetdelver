import { cloneDocument } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import type {
    CompendiumDiscoveryResult,
    CompendiumIndexEntry,
    CompendiumIndexLookupResult,
    CompendiumIndexOptions,
    CompendiumIndexVariant,
    CompendiumPackIndexSnapshot,
    CompendiumPackMetadata,
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

/**
 * ADR-0015 Phase 1 Store for active-world compendium index state.
 *
 * This is intentionally index-only. Module-declared hydrated pack rows live in
 * CompendiumPackStore; this Store owns the lightweight Pathway A
 * index snapshots plus field-aware index variants used to avoid duplicate
 * fetches when Pathway B needs the same rows.
 */
export class CompendiumStore {
    private packs = new Map<string, StoredPack>();

    public clear(_reason?: string): void {
        this.packs.clear();
    }

    public isReady(): boolean {
        return this.packs.size > 0;
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

    private getVariant(packId: string, options: CompendiumIndexOptions = {}): CompendiumIndexVariant | null {
        const pack = this.packs.get(packId);
        if (!pack) return null;
        const fieldKey = fieldKeyFor(options.fields);
        return pack.variants.get(fieldKey) || null;
    }
}

export const compendiumStore = new CompendiumStore();
