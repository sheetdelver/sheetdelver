import { logger } from '@shared/utils/logger';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { persistentCache } from '../cache/PersistentCache';
import { CoreSocket } from './sockets/CoreSocket';
import { DiscoveryConfig, PackDiscoveryConfig } from '@shared/sdk';
import crypto from 'node:crypto';

export interface PackManifestEntry {
    id: string;
    hash: string;
    lastUpdated: number;
    rowCount: number;
}

export interface SystemDiscoveryManifest {
    systemId: string;
    packs: Record<string, PackManifestEntry>;
    _instanceId: string;
}

export class DiscoveryService {
    private static instance: DiscoveryService;

    private constructor() { }

    public static getInstance(): DiscoveryService {
        if (!DiscoveryService.instance) {
            DiscoveryService.instance = new DiscoveryService();
        }
        return DiscoveryService.instance;
    }

    /**
     * Synchronize system compendiums with the local sharded cache.
     * @param client The system-wide CoreSocket
     * @param systemId The system namespace (e.g., 'shadowdark')
     * @param config The declarative discovery configuration from the adapter
     */
    public async sync(client: CoreSocket, systemId: string, config: DiscoveryConfig): Promise<SystemDiscoveryManifest> {
        logger.info(`DiscoveryService | Starting sync for system: ${systemId}...`);

        const manifestKey = `manifest-${systemId}`;
        const existingManifest = await persistentCache.get<SystemDiscoveryManifest>(systemId, manifestKey) || {
            systemId,
            packs: {},
            _instanceId: crypto.randomUUID()
        };

        const newManifest: SystemDiscoveryManifest = {
            ...existingManifest,
            packs: { ...existingManifest.packs }
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
            await persistentCache.set(systemId, manifestKey, newManifest);
            logger.info(`DiscoveryService | Sync complete for ${systemId}. ${updatedCount} packs updated.`);
        } else {
            logger.info(`DiscoveryService | Sync complete for ${systemId}. All packs up to date.`);
        }

        return newManifest;
    }

    private async syncPack(
        client: CoreSocket,
        systemId: string,
        packConfig: PackDiscoveryConfig,
        manifest: SystemDiscoveryManifest
    ): Promise<boolean> {
        const packId = packConfig.id;
        
        // 1. Get current signature from Foundry
        const entries = await client.getPackEntries(packId, { index: true });
        if (!entries || !Array.isArray(entries)) {
            throw new Error(`Could not find pack ${packId} in Foundry or result was not an array.`);
        }

        // Use the aggregate entry IDs as a base for the signature if Foundry doesn't provide a hash
        const currentHash = this.computeHash(entries, packConfig.hydrate || false);
        const existing = manifest.packs[packId];

        if (existing && existing.hash === currentHash) {
            const shardExists = await persistentCache.get(systemId, `pack-${packId.replace('.', '-')}`);
            if (shardExists) {
                logger.debug(`DiscoveryService | Pack ${packId} is up to date (Hash: ${currentHash.substring(0, 8)})`);
                return false;
            }
        }

        // 2. Fetch/Hydrate data
        logger.info(`DiscoveryService | Syncing stale pack: ${packId} (${packConfig.hydrate ? 'FULL HYDRATION' : 'INDEXED'})...`);
        
        let documents: any[] = [];

        if (packConfig.hydrate) {
            // "Proven Winner" hydration strategy: iterate IDs to get full documents
            const ids = entries.map((e: any) => e._id || e.id);
            
            // Chunk requests if the list is huge (e.g. 50 at a time)
            const CHUNK_SIZE = 50;
            for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
                const chunk = ids.slice(i, i + CHUNK_SIZE);
                const response: any = await client.emitSocketEvent('modifyDocument', {
                    type: packConfig.type,
                    action: 'get',
                    operation: {
                        pack: packId,
                        index: false,
                        ids: chunk
                    }
                }, 5000);

                if (response?.result && Array.isArray(response.result)) {
                    documents = documents.concat(response.result);
                }
            }
        } else {
            // Lightweight indexed fetch
            documents = await client.getPackEntries(packId, { 
                index: true, 
                fields: packConfig.fields || ['name', 'img', 'type'] 
            }) || [];
        }

        // 3. Save Shard
        await persistentCache.set(systemId, `pack-${packId.replace('.', '-')}`, documents);

        // 4. Update Manifest
        manifest.packs[packId] = {
            id: packId,
            hash: currentHash,
            lastUpdated: Date.now(),
            rowCount: documents.length
        };

        return true;
    }

    private computeHash(entries: any[], hydrate: boolean): string {
        const signatureString = entries
            .map(e => `${e._id || e.id}-${e.name}`)
            .concat(hydrate ? ['HYDRATED'] : ['INDEXED'])
            .sort()
            .join('|');
        return crypto.createHash('md5').update(signatureString).digest('hex');
    }
}

export const discoveryService = DiscoveryService.getInstance();
