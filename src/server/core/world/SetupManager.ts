import { logger } from '@shared/utils/logger';
import { persistentCache } from '../cache/PersistentCache';

export interface WorldUser {
    _id: string;
    name: string;
    role: number;
}

export interface WorldData {
    worldId: string;
    worldTitle: string;
    worldDescription: string | null;
    systemId: string;
    systemVersion?: string;
    backgroundUrl: string | null;
    users: WorldUser[];
    lastUpdated: string;
    modules?: any[];
    data?: any;
}

export interface CacheData {
    worlds: Record<string, WorldData>;
    currentWorldId: string | null;
}

const CACHE_NS = 'core';
const CACHE_KEY = 'worlds';
const CACHE_MAX_AGE_DAYS = 7;

/**
 * Setup-mode world cache helper.
 *
 * Owns the disk-backed snapshot of imported worlds used by the admin UI
 * for setup/status flows. Per ADR-0022 Phase 1, the in-app world-scrape /
 * authenticated-probe paths were removed; equivalent operator mechanics
 * live in `src/scripts/tools/admin/scrape-world.ts` (`npm run admin:scrape`).
 */
export class SetupManager {
    /**
     * Save world data to cache
     */
    static async saveCache(worldData: WorldData, setActive: boolean = true): Promise<void> {
        const cache = await this.loadCache();

        cache.worlds[worldData.worldId] = worldData;
        if (setActive) {
            cache.currentWorldId = worldData.worldId;
        }

        await persistentCache.set(CACHE_NS, CACHE_KEY, cache);
    }

    /**
     * Save multiple worlds to cache without changing active world
     */
    static async saveBatchCache(worldsData: WorldData[]): Promise<void> {
        const cache = await this.loadCache();

        for (const w of worldsData) {
            cache.worlds[w.worldId] = w;
        }

        await persistentCache.set(CACHE_NS, CACHE_KEY, cache);
    }

    /**
     * Load all cached worlds
     */
    static async loadCache(): Promise<CacheData> {
        logger.debug('[SetupManager] loadCache called.');

        try {
            const cache = await persistentCache.get<CacheData>(CACHE_NS, CACHE_KEY);
            if (!cache) {
                logger.warn('[SetupManager] Cache is null or undefined');
                return { worlds: {}, currentWorldId: null };
            }

            // Validate that the current world actually has users
            if (cache.currentWorldId && cache.worlds[cache.currentWorldId]) {
                const world = cache.worlds[cache.currentWorldId];
                if (!world.users || world.users.length === 0) {
                    logger.warn(`[SetupManager] Cache exists for ${world.worldTitle} but has 0 users. Treating as invalid/setup-required.`);
                    return { ...cache, currentWorldId: null };
                }
            } else {
                logger.warn('[SetupManager] currentWorldId mismatch or missing in worlds map');
            }

            return cache;
        } catch (e) {
            logger.error('[SetupManager] Error loading cache:', e);
            return { worlds: {}, currentWorldId: null };
        }
    }

    /**
     * Get cached world data by ID
     */
    static async getCachedWorld(worldId: string): Promise<WorldData | null> {
        const cache = await this.loadCache();
        return cache.worlds[worldId] || null;
    }

    /**
     * Validate cache freshness (< 7 days old)
     */
    static async validateCache(worldId: string): Promise<boolean> {
        const world = await this.getCachedWorld(worldId);
        if (!world) return false;

        const lastUpdated = new Date(world.lastUpdated);
        const now = new Date();
        const ageInDays = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);

        return ageInDays < CACHE_MAX_AGE_DAYS;
    }
}
