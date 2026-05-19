import { logger } from '@shared/utils/logger';
import { compendiumStore, type CompendiumStore } from './CompendiumStore';
import type { CompendiumDiscoveryResult, CompendiumPackIndexSnapshot } from './types';

/**
 * ADR-0014 Phase 4 home for the legacy UUID-to-name compendium index.
 *
 * This is intentionally still a small name lookup cache. The broader
 * compendium architecture, shard readers, and pathway A/B behavior belong to
 * ADR-0015; this phase only moved the existing singleton out of `core/foundry`
 * so later compendium work has a canonical package to grow into.
 *
 * ADR-0015 Phase 2 changes the warmup source: the cache now rebuilds from
 * CompendiumStore/service discovery results, not from a socket metadata client.
 */
export class CompendiumCache {
    private static instance: CompendiumCache;
    private cache: Map<string, string> = new Map();
    private initialized = false;

    private constructor() { }

    public static getInstance(): CompendiumCache {
        if (!CompendiumCache.instance) {
            CompendiumCache.instance = new CompendiumCache();
        }
        return CompendiumCache.instance;
    }

    public hasLoaded(): boolean {
        return this.initialized;
    }

    public rebuildFromPacks(packs: CompendiumDiscoveryResult[]): void {
        logger.debug('Rebuilding Compendium Cache from discovered pack indices...');
        this.cache.clear();

        for (const pack of packs) {
            this.ingestPack(pack.id, pack.metadata, pack.index);
        }

        this.initialized = true;
        logger.debug(`Compendium Cache rebuilt with ${this.cache.size} items.`);
    }

    public rebuildFromStore(store: CompendiumStore = compendiumStore): void {
        this.rebuildFromPacks(store.listPackIndices().map((snapshot: CompendiumPackIndexSnapshot) => ({
            id: snapshot.id,
            metadata: snapshot.metadata,
            index: snapshot.variant.index,
            fields: snapshot.variant.fields,
        })));
    }

    public async initialize(_legacySource?: unknown): Promise<void> {
        // Compatibility shim for older callers. ADR-0015 Phase 2 intentionally
        // ignores the old socket metadata source; bootstrap should run
        // CompendiumService.discoverIndices() before rebuilding this cache.
        if (this.initialized) return;
        this.rebuildFromStore();
    }

    private ingestPack(packId: string, metadata: CompendiumDiscoveryResult['metadata'], index: CompendiumDiscoveryResult['index']): void {
        const docType = metadata?.type || metadata?.entity || metadata?.documentName || 'Item';
        if (!packId || !Array.isArray(index)) return;

        for (const item of index) {
            const id = item._id || item.id;
            const name = item.name;
            if (id && name) {
                // Standardize: Compendium.{packId}.{Type}.{Id}
                const uuid = `Compendium.${packId}.${docType}.${id}`;
                this.cache.set(uuid, name);
            }
        }
    }

    public getName(uuid: string): string | undefined {
        const val = this.cache.get(uuid);
        // if (!val) logger.info(`[CompendiumCache] Miss: ${uuid}`);
        return val;
    }

    public getKeys(): string[] {
        return Array.from(this.cache.keys());
    }

    public resolve(text: string): string {
        // Simple replacement for now, or direct lookup
        if (this.cache.has(text)) return this.cache.get(text)!;
        return text;
    }
    public set(uuid: string, name: string): void {
        this.cache.set(uuid, name);
    }

    public reset(): void {
        this.cache.clear();
        this.initialized = false;
        logger.info('CompendiumCache | Cache cleared.');
    }
}
