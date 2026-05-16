import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { loadConfig } from '@core/config';
import { userStore } from '@server/core/documents/primary/users/UserStore';

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

        // Test 4a: UserStore roster
        logger.info('4a. Testing UserStore roster...');
        try {
            const users = userStore.listWithPresence();
            logger.info(`   ✅ Found ${users.length} users`);
            users.forEach((u: any) => {
                logger.info(`      - ${u.name}: Role ${u.role} (${typeof u.role})`);
            });
            results.tests.push({ name: 'UserStore roster', success: true, data: { count: users.length } });
        } catch (error: any) {
            logger.info(`   ❌ Failed: ${error.message}`);
            results.tests.push({ name: 'UserStore roster', success: false, error: error.message });
        }

        // Test 4b: gameData users snapshot
        logger.info('\n4b. Testing gameData users snapshot...');
        try {
            await client.getGameData()['users'];
            logger.info(`   ✅ Retrieved detailed user info`);
            results.tests.push({ name: 'gameData users snapshot', success: true });
        } catch (error: any) {
            logger.info(`   ❌ Failed: ${error.message}`);
            results.tests.push({ name: 'gameData users snapshot', success: false, error: error.message });
        }

        // Test 4c: getAllCompendiumIndices()
        logger.info('\n4c. Testing getAllCompendiumIndices()...');
        try {
            const indices = await client.getAllCompendiumIndices();
            logger.info(`   ✅ Found ${indices.length} compendium packs`);
            results.tests.push({ name: 'getAllCompendiumIndices', success: true, data: { count: indices.length } });
        } catch (error: any) {
            logger.info(`   ❌ Failed: ${error.message}`);
            results.tests.push({ name: 'getAllCompendiumIndices', success: false, error: error.message });
        }

        const successCount = results.tests.filter((t: any) => t.success).length;
        results.success = successCount === results.tests.length;

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
