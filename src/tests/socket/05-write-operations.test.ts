import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { loadConfig } from '@core/config';
import { createSystemRouteFoundryClient } from '@server/shared/utils/createRouteFoundryClient';

/**
 * Test 5: Write Operations (Safe CRUD)
 * Tests creating, updating, and deleting a temporary actor to verify write capabilities.
 */
export async function testWriteOperations() {
    logger.info('🧪 Test 5: Write Operations (Safe CRUD)\n');

    const config = await loadConfig();
    if (!config) {
        throw new Error('Failed to load configuration');
    }

    const client = new CoreSocket(config.foundry);
    const results: any = { tests: [] };
    let tempActorId: string | null = null;
    let tempItemId: string | null = null;
    let routeClient: ReturnType<typeof createSystemRouteFoundryClient> | null = null;

    const resolveValidActorType = async (): Promise<string> => {
        const existingActors = await routeClient!.getActors();
        const actorTypeFromWorld = existingActors.find((actor: any) => typeof actor?.type === 'string' && actor.type.length > 0)?.type;
        if (actorTypeFromWorld) return actorTypeFromWorld;

        try {
            const systemData = await client.getSystem();
            const actorTypeKeys = Object.keys(systemData?.documentTypes?.Actor || {});
            if (actorTypeKeys.length > 0) {
                return actorTypeKeys[0];
            }
        } catch (error: any) {
            logger.warn(`Could not inspect system documentTypes.Actor for actor type fallback: ${error.message}`);
        }

        logger.warn('Falling back to default actor type "character" because no active actor type footprint was discovered.');
        return 'character';
    };

    try {
        await client.connect();
        routeClient = createSystemRouteFoundryClient(client);
        logger.info('✅ Connected\n');

        // Test 5a: Create Temporary Actor
        logger.info('5a. Creating temporary actor...');
        try {
            const actorType = await resolveValidActorType();
            const actorData = {
                name: "TEMP_TEST_ACTOR_" + Date.now(),
                // Use a type known to the active system/world to avoid schema validation drift.
                type: actorType,
                img: "icons/svg/mystery-man.svg"
            };
            const createdActor = await routeClient.createActor(actorData) as Record<string, any> | null | undefined;
            if (!createdActor?._id) throw new Error('Actor creation returned no document id');
            tempActorId = createdActor._id;
            logger.info(`   ✅ Created actor: ${createdActor.name} (${tempActorId})`);
            results.tests.push({ name: 'createActor', success: true, data: { id: tempActorId } });
        } catch (error: any) {
            logger.info(`   ❌ Failed: ${error.message}`);
            results.tests.push({ name: 'createActor', success: false, error: error.message });
            // Cannot proceed if creation failed
            throw new Error("Generic CRUD test aborted due to creation failure");
        }

        // Test 5b: Update Actor
        if (tempActorId) {
            logger.info('\n5b. Updating temporary actor...');
            try {
                const updateData = {
                    name: "UPDATED_TEST_ACTOR_" + Date.now(),
                    "system.details.biography": "<p>Updated via socket test</p>"
                };
                await routeClient.updateActor(tempActorId, updateData);

                // Verify update
                const updatedActor = await routeClient.getActor(tempActorId);
                if (updatedActor?.name?.startsWith("UPDATED_TEST_ACTOR")) {
                    logger.info(`   ✅ Updated actor name to: ${updatedActor.name}`);
                    results.tests.push({ name: 'updateActor', success: true });
                } else {
                    throw new Error("Update checks failed - name did not change");
                }
            } catch (error: any) {
                logger.info(`   ❌ Failed: ${error.message}`);
                results.tests.push({ name: 'updateActor', success: false, error: error.message });
            }
        }

        // Test 5c: Create Item on Actor
        if (tempActorId) {
            logger.info('\n5c. Creating item on actor...');
            try {
                const itemData = {
                    name: "Test Item",
                    type: "Basic", // Shadowdark specific type
                    img: "icons/svg/item-bag.svg"
                };
                // Note: Shadowdark specific types might be 'Basic', 'Weapon' etc. 
                // Using 'Item' as a broad guess, or we can try to inspect system types if we had them.
                // Let's try to be generic.

                tempItemId = await routeClient.createActorItem(tempActorId, itemData) as string;
                logger.info(`   ✅ Created item: ${tempItemId}`);
                results.tests.push({ name: 'createActorItem', success: true, data: { id: tempItemId } });
            } catch (error: any) {
                // Some systems are strict about Item Types. 
                // If this fails, it might be due to invalid type 'Item'.
                logger.info(`   ❌ Failed (Type might be invalid for system): ${error.message}`);
                results.tests.push({ name: 'createActorItem', success: false, error: error.message });
            }
        }

        // Test 5d: Chat Message
        logger.info('\n5d. Sending test chat message...');
        try {
            await routeClient.createChatMessage({
                content: "🧪 Socket Test: Write Operations Verified",
                type: 1,
                author: client.userId,
            });
            logger.info(`   ✅ Sent chat message`);
            results.tests.push({ name: 'createChatMessage', success: true });
        } catch (error: any) {
            logger.info(`   ❌ Failed: ${error.message}`);
            results.tests.push({ name: 'createChatMessage', success: false, error: error.message });
        }

        const successCount = results.tests.filter((t: any) => t.success).length;
        results.success = successCount === results.tests.length;

        logger.info(`\n📊 ${successCount}/${results.tests.length} tests passed`);
        return results;

    } catch (error: any) {
        logger.error('❌ Test suite failed:', error.message);
        return { success: false, error: error.message };
    } finally {
        // CLEANUP: Always delete the temporary actor
        if (tempActorId) {
            logger.info('\n🧹 Cleaning up: Deleting temporary actor...');
            try {
                await routeClient?.deleteActor(tempActorId);
                logger.info('   ✅ cleanup successful');
            } catch (cleanupError: any) {
                logger.error(`   ⚠️ Cleanup failed: ${cleanupError.message}. Please manually delete actor ${tempActorId}`);
            }
        }
        await client.disconnect();
        logger.info('📡 Disconnected\n');
    }
}

import { fileURLToPath } from 'url';
import { logger } from '@shared/utils/logger';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    testWriteOperations().then(result => {
        process.exit(result.success ? 0 : 1);
    });
}
