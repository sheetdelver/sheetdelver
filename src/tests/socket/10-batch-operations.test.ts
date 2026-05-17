import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { loadConfig } from '@core/config';
import { createSystemRouteFoundryClient } from '@server/shared/utils/createRouteFoundryClient';

/**
 * Test 10: Batch Operations
 * Verifies that CoreSocket can handle both single and multiple document creations reliably.
 */
export async function testBatchOperations() {
    logger.info('🧪 Test 10: Batch Operations\n');

    const config = await loadConfig();
    if (!config) throw new Error("Config not loaded");
    const client = new CoreSocket(config.foundry);
    let tempActorId: string | null = null;
    let tempActorIds: string[] = [];

    try {
        await client.connect();
        const routeClient = createSystemRouteFoundryClient(client);

        // 1. Single Actor Creation
        logger.info('1. Testing Single Actor Creation...');
        const singleActor = await routeClient.createActor({
            name: "Single Test Actor " + Date.now(),
            type: "NPC"
        }) as any;
        if (!singleActor || !singleActor._id) throw new Error("Single actor creation failed");
        tempActorId = singleActor._id;
        logger.info(`   ✅ Success: ${singleActor._id}`);

        // 2. Single Item Creation
        logger.info('\n2. Testing Single Item Creation on Actor...');
        const itemId = await routeClient.createActorItem(tempActorId!, {
            name: "Single Item",
            type: "Basic"
        });
        if (!itemId) throw new Error("Single item creation failed");
        logger.info(`   ✅ Success: ${itemId}`);

        // 3. Batch Item Creation (The culprit for the reported bug)
        logger.info('\n3. Testing Batch Item Creation (Array)...');
        const items = [
            { name: "Batch Item 1", type: "Basic" },
            { name: "Batch Item 2", type: "Basic" }
        ];
        const itemResults = await routeClient.createActorItem(tempActorId!, items) as any[];
        if (!Array.isArray(itemResults) || itemResults.length !== 2) {
            throw new Error(`Batch item creation failed. Expected 2 results, got: ${JSON.stringify(itemResults)}`);
        }
        logger.info(`   ✅ Success: Created ${itemResults.length} items`);

        // 4. Batch Actor Creation
        logger.info('\n4. Testing Batch Actor Creation...');
        const actors = [
            { name: "Batch Actor 1", type: "NPC" },
            { name: "Batch Actor 2", type: "NPC" }
        ];
        const actorResults = await routeClient.createActor(actors) as any[];
        if (!Array.isArray(actorResults) || actorResults.length !== 2) {
            throw new Error(`Batch actor creation failed. Expected 2 results, got: ${JSON.stringify(actorResults)}`);
        }
        tempActorIds = actorResults.map((a: any) => a._id);
        logger.info(`   ✅ Success: Created ${actorResults.length} actors`);

        logger.info('\n🎉 All Batch Operation Tests Passed!');
        return { success: true };

    } catch (e: any) {
        logger.error(`\n❌ Batch Test Failed: ${e.message}`);
        return { success: false, error: e.message };
    } finally {
        logger.info('\n🧹 Cleaning up...');
        const routeClient = createSystemRouteFoundryClient(client);
        if (tempActorId) await routeClient.deleteActor(tempActorId).catch(() => { });
        for (const id of tempActorIds) {
            if (id) await routeClient.deleteActor(id).catch(() => { });
        }
        await client.disconnect();
    }
}

import { fileURLToPath } from 'url';
import { logger } from '@shared/utils/logger';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    testBatchOperations().then(_res => process.exit(_res.success ? 0 : 1));
}
