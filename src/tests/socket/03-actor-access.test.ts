import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { loadConfig } from '@core/config';
import { createSystemRouteFoundryClient } from '@server/shared/utils/createRouteFoundryClient';

/**
 * Test 3: Actor Data Access
 * Tests reading actor data from the world
 */
export async function testActorAccess() {
    logger.info('🧪 Test 3: Actor Data Access\n');

    const config = await loadConfig();
    if (!config) {
        throw new Error('Failed to load configuration');
    }

    const client = new CoreSocket(config.foundry);
    const results: any = { tests: [] };

    try {
        await client.connect();
        const routeClient = createSystemRouteFoundryClient(client);
        logger.info('✅ Connected\n');

        // Test 3a: getActors()
        logger.info('3a. Testing getActors()...');
        try {
            const actors = await routeClient.getActors();
            logger.info(`   ✅ Found ${actors.length} actors`);
            if (actors.length > 0) {
                logger.info(`   First actor: ${actors[0].name} (${actors[0]._id})`);
            }
            results.tests.push({ name: 'getActors', success: true, data: { count: actors.length } });
            results.actors = actors;
        } catch (error: any) {
            logger.info(`   ❌ Failed: ${error.message}`);
            results.tests.push({ name: 'getActors', success: false, error: error.message });
            results.actors = [];
        }

        // Test 3b: getActor(id) - only if we have actors
        if (results.actors.length > 0) {
            const testActorId = results.actors[0]._id;
            logger.info(`\n3b. Testing getActor('${testActorId}')...`);
            try {
                const actor = await routeClient.getActor(testActorId);
                if (!actor) throw new Error(`Actor ${testActorId} not found`);
                logger.info(`   ✅ Retrieved: ${actor.name}`);
                logger.info(`   Type: ${actor.type}`);
                results.tests.push({ name: 'getActor', success: true, data: { name: actor.name, type: actor.type } });
            } catch (error: any) {
                logger.info(`   ❌ Failed: ${error.message}`);
                results.tests.push({ name: 'getActor', success: false, error: error.message });
            }
        } else {
            logger.info('\n3b. Skipping getActor() - no actors available');
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
    testActorAccess().then(result => {
        process.exit(result.success ? 0 : 1);
    });
}
