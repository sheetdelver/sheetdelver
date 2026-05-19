import { logger } from '@shared/utils/logger';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { discoveryShardStore, type DiscoveryShardStore } from '@server/core/compendium/DiscoveryShardStore';
import type { DiscoveryConfig, PackDiscoveryConfig } from '@shared/sdk';
import type { DiscoveryShardManifest } from '@server/core/compendium/types';
import crypto from 'node:crypto';

export interface DiscoverySyncClient {
    getPackEntries(packId: string, options?: { index?: boolean; fields?: readonly string[] }): Promise<unknown[]>;
    emitSocketEvent<T>(event: string, ...payloads: unknown[]): Promise<T>;
}

export class DiscoveryService {
    private static instance: DiscoveryService;

    public constructor(private readonly shardStore: DiscoveryShardStore = discoveryShardStore) { }

    public static getInstance(): DiscoveryService {
        if (!DiscoveryService.instance) {
            DiscoveryService.instance = new DiscoveryService();
        }
        return DiscoveryService.instance;
    }

    /**
     * Synchronize module-declared compendiums with the local persistent shard cache.
     *
     * ADR-0015 Phase 3 keeps the existing freshness/hash behavior intact while
     * moving the service out of `core/foundry`. Later phases can de-duplicate
     * Pathway A/B index fetches without changing the shard read surface.
     */
    public async sync(
        client: DiscoverySyncClient,
        systemId: string,
        config: DiscoveryConfig,
    ): Promise<DiscoveryShardManifest> {
        logger.info(`DiscoveryService | Starting sync for system: ${systemId}...`);

        const existingManifest = await this.shardStore.getManifest(systemId) || {
            systemId,
            packs: {},
            _instanceId: crypto.randomUUID(),
        };

        const newManifest: DiscoveryShardManifest = {
            ...existingManifest,
            packs: { ...existingManifest.packs },
        };

        let updatedCount = 0;

        for (const packConfig of config.packs) {
            try {
                const refreshed = await this.syncPack(client, systemId, packConfig, newManifest);
                if (refreshed) updatedCount++;
            } catch (err: unknown) {
                logger.error(`DiscoveryService | Failed to sync pack ${packConfig.id}: ${getErrorMessage(err)}`);
            }
        }

        if (updatedCount > 0) {
            await this.shardStore.setManifest(newManifest);
            logger.info(`DiscoveryService | Sync complete for ${systemId}. ${updatedCount} packs updated.`);
        } else {
            logger.info(`DiscoveryService | Sync complete for ${systemId}. All packs up to date.`);
        }

        return newManifest;
    }

    private async syncPack(
        client: DiscoverySyncClient,
        systemId: string,
        packConfig: PackDiscoveryConfig,
        manifest: DiscoveryShardManifest,
    ): Promise<boolean> {
        const packId = packConfig.id;

        const entries = await client.getPackEntries(packId, { index: true });
        if (!entries || !Array.isArray(entries)) {
            throw new Error(`Could not find pack ${packId} in Foundry or result was not an array.`);
        }

        const currentHash = this.computeHash(entries, packConfig.hydrate || false);
        const existing = manifest.packs[packId];

        if (existing && existing.hash === currentHash) {
            const shardExists = await this.shardStore.getShard(systemId, packId);
            if (shardExists) {
                logger.debug(`DiscoveryService | Pack ${packId} is up to date (Hash: ${currentHash.substring(0, 8)})`);
                return false;
            }
        }

        logger.info(`DiscoveryService | Syncing stale pack: ${packId} (${packConfig.hydrate ? 'FULL HYDRATION' : 'INDEXED'})...`);

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
            documents = await client.getPackEntries(packId, {
                index: true,
                fields: packConfig.fields || ['name', 'img', 'type'],
            }) as Record<string, unknown>[] || [];
        }

        await this.shardStore.setShard(systemId, packId, documents);

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
}

export const discoveryService = DiscoveryService.getInstance();
