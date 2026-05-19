import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { loadConfig } from '@core/config';
import { worldStateStore } from '@core/world/WorldStateStore';

/**
 * Test 2: System Information Retrieval
 * Tests read-only system data access
 */
export async function testSystemInfo() {
    logger.info('🧪 Test 2: System Information\n');

    const config = await loadConfig();
    if (!config) {
        throw new Error('Failed to load configuration');
    }

    const client = new CoreSocket(config.foundry);
    const results: any = { tests: [] };

    try {
        await client.connect();
        logger.info('✅ Connected\n');

        // Test 2a: system metadata from WorldStateStore
        logger.info('2a. Testing WorldStateStore.getSystem()...');
        try {
            const system = worldStateStore.getSystem();
            if (!system) throw new Error('System metadata unavailable');
            logger.info(`   ✅ System: ${system.id} v${system.version}`);
            results.tests.push({ name: 'WorldStateStore.getSystem', success: true, data: system });
        } catch (error: any) {
            logger.info(`   ❌ Failed: ${error.message}`);
            results.tests.push({ name: 'WorldStateStore.getSystem', success: false, error: error.message });
        }

        // Test 2b: world snapshot from WorldStateStore
        logger.info('\n2b. Testing WorldStateStore.getGameDataSnapshot()...');
        try {
            const gameData = worldStateStore.getGameDataSnapshot();
            if (!gameData) throw new Error('Game data snapshot unavailable');
            logger.info('   ✅ Retrieved system data\n');
            results.tests.push({ name: 'WorldStateStore.getGameDataSnapshot', success: true });
        } catch (error: any) {
            logger.info(`   ❌ Failed: ${error.message}`);
            results.tests.push({ name: 'WorldStateStore.getGameDataSnapshot', success: false, error: error.message });
        }

        // Test 2c: evaluate() for world info
        logger.info('\n2c. Testing evaluate() for world info...');
        try {
            // @ts-ignore
            const worldId = await client.evaluate(() => (world as any).id);
            // @ts-ignore
            const worldTitle = await client.evaluate(() => (world as any).title);
            logger.info(`   ✅ World: ${worldTitle} (${worldId})`);
            results.tests.push({ name: 'evaluate-world', success: true, data: { worldId, worldTitle } });
        } catch (error: any) {
            logger.info(`   ❌ Failed: ${error.message}`);
            results.tests.push({ name: 'evaluate-world', success: false, error: error.message });
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
    testSystemInfo().then(result => {
        process.exit(result.success ? 0 : 1);
    });
}
