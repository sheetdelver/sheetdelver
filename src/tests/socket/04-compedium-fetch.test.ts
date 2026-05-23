import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { loadConfig } from '@core/config';
import { compendiumStore } from '@core/compendium';
import { CompendiumService } from '@server/services/compendium';
import type { CompendiumPackMetadata } from '@server/core/compendium/types';
import { worldStateStore } from '@core/world/WorldStateStore';
import * as fs from 'fs';

/**
 * Test 4: User and Compendium Data
 * Tests user list and compendium access
 */
export async function testUsersAndCompendia() {
    logger.info('🧪 Test 4: Users & Compendium Data\n');

    const config = await loadConfig();
    if (!config) {
        throw new Error('Failed to load configuration');
    }

    const client = new CoreSocket(config.foundry);
    const results: any = { tests: [] };

    try {
        await client.connect();
        logger.info('✅ Connected\n');

        const system = worldStateStore.getSystem();
        if (!system) throw new Error('System metadata unavailable');
        // Output system id
        logger.info(`   ✅ System ID: ${system.id}`);
        const compendiumService = new CompendiumService({
            transport: client,
            store: compendiumStore,
        });

        // Seed pack metadata passively from the bootstrap envelope (no transport).
        const gameData = worldStateStore.getGameDataSnapshot();
        if (gameData) compendiumStore.seedPackMetadataFromGameData(gameData, 'socket-test');

        // Filter to game.data top-level packs to mirror the old onlyGamePacks flag.
        const topLevelIds = new Set((gameData?.packs ?? []).map(pack => pack.id).filter(Boolean) as string[]);
        const inventory: CompendiumPackMetadata[] = compendiumStore.listPackMetadata().filter(pack => pack.id && topLevelIds.has(pack.id));

        logger.info('\n4a. Seeded passive compendium pack metadata from game.data.packs...');
        logger.info(`   ✅ Found ${inventory.length} compendium packs`);
        results.tests.push({ name: 'compendiumStore.seedPackMetadataFromGameData', success: inventory.length > 0, data: { count: inventory.length } });
        if (inventory.length === 0) {
            logger.info(`   ❌ No compendium packs found`);
        }

        const successCount = results.tests.filter((t: any) => t.success).length;
        results.success = successCount === results.tests.length;

        // Create directory in temp/systemid
        const dir = `temp/${system.id}`;
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        // Fetch full documents on demand using the explicit pack primitive.
        for (const pack of inventory) {
            logger.info(`   ✅ Found ${pack.id} compendium pack`);
            const docType = pack.type || pack.entity || 'Item';
            const items = await compendiumService.getPackDocuments(pack.id!, docType);
            logger.info(`   ✅ Fetched ${items.length} full documents from ${pack.name || pack.id}`);
            fs.writeFileSync(`${dir}/${pack.id}.json`, JSON.stringify(items, null, 2));
        }

        logger.info(`\n📊 ${successCount}/${results.tests.length} tests passed`);
        return results;

    } catch (error: any) {
        logger.error('❌ Test suite failed:', error.message);
        return { success: false, error: error.message };
    } finally {
        await client.disconnect();
        logger.info('📡 Disconnected\n');
    }
}

import { fileURLToPath } from 'url';
import { logger } from '@shared/utils/logger';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    testUsersAndCompendia().then(result => {
        process.exit(result.success ? 0 : 1);
    });
}
