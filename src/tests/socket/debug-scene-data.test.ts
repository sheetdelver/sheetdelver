import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { loadConfig } from '@core/config';
import { worldStateStore } from '@core/world/WorldStateStore';

/**
 * Debug Test: Scene Data Capture
 * Tests scene data retrieval and outputs captured data for debugging
 */
export async function testSceneData() {
    logger.info('🧪 Debug Test: Scene Data Capture\n');

    const config = await loadConfig();
    if (!config) {
        throw new Error('Failed to load configuration');
    }

    const client = new CoreSocket(config.foundry);
    const results: any = { tests: [] };

    try {
        logger.info('Connecting to Foundry...');
        await client.connect();
        logger.info('✅ Connected\n');

        // Test 1: Check if WorldStateStore scene snapshot is populated
        logger.info('1. Checking WorldStateStore scene data...');
        const sceneData = worldStateStore.getSceneData();

        if (sceneData) {
            logger.info('✅ Scene data cached!');
            logger.info(`   Type: ${typeof sceneData}`);
            logger.info(`   Keys: ${Object.keys(sceneData).length}`);

            // List all scene IDs
            const sceneIds = Object.keys(sceneData);
            logger.info(`\n   Scene IDs found: ${sceneIds.join(', ')}`);

            // Check for NUEDEFAULTSCENE0
            if (sceneData.NUEDEFAULTSCENE0) {
                logger.info('\n✅ NUEDEFAULTSCENE0 found!');
                const defaultScene = sceneData.NUEDEFAULTSCENE0;
                logger.info(`   Name: ${defaultScene.name}`);
                logger.info(`   Background: ${defaultScene.background?.src || 'null'}`);

                results.tests.push({
                    name: 'default-scene',
                    success: true,
                    data: {
                        name: defaultScene.name,
                        backgroundSrc: defaultScene.background?.src
                    }
                });
            } else {
                logger.info('\n❌ NUEDEFAULTSCENE0 not found in scene data');
                results.tests.push({
                    name: 'default-scene',
                    success: false,
                    error: 'NUEDEFAULTSCENE0 not found',
                    availableScenes: sceneIds
                });
            }

            // Output full scene data for debugging
            logger.info('\n📋 Full Scene Data:');
            logger.info(JSON.stringify(sceneData, null, 2));

        } else {
            logger.info('❌ Scene data is null/undefined');
            logger.info('   This means fetchSceneData() failed or returned null');
            results.tests.push({
                name: 'scene-data-cache',
                success: false,
                error: 'sceneDataCache is null'
            });
        }

        // Test 2: Check game snapshot for comparison
        logger.info('\n\n2. Checking game data snapshot for comparison...');
        try {
            const gameData = worldStateStore.getGameDataSnapshot();

            if (gameData) {
                logger.info('✅ Game data snapshot available');
                logger.info(`   System: ${gameData.system?.id}`);
                logger.info(`   World: ${gameData.world?.title}`);
                logger.info(`   Background: ${gameData.system?.background || 'null'}`);

                results.tests.push({
                    name: 'game-data-snapshot',
                    success: true
                });
            } else {
                logger.info('❌ Game data snapshot is null');
                results.tests.push({
                    name: 'game-data-snapshot',
                    success: false,
                    error: 'WorldStateStore game data snapshot is null'
                });
            }
        } catch (error: any) {
            logger.info(`❌ Game snapshot check failed: ${error.message}`);
            results.tests.push({
                name: 'game-data-snapshot',
                success: false,
                error: error.message
            });
        }

        const successCount = results.tests.filter((t: any) => t.success).length;
        results.success = successCount === results.tests.length;

        logger.info(`\n\n📊 ${successCount}/${results.tests.length} tests passed`);
        return results;

    } catch (error: any) {
        logger.error('❌ Test suite failed:', error.message);
        logger.error(error.stack);
        return { success: false, error: error.message };
    } finally {
        await client.disconnect();
        logger.info('\n📡 Disconnected\n');
    }
}

import { fileURLToPath } from 'url';
import { logger } from '@shared/utils/logger';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    testSceneData().then(result => {
        process.exit(result.success ? 0 : 1);
    });
}
