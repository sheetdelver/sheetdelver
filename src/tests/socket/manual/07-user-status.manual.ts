import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { loadConfig } from '@core/config';
import { userStore } from '@server/core/documents/primary/users/UserStore';

/**
 * Test 7: Exploratory - User Status
 * Tests if we can retrieve User documents and trust their 'active' status
 */
export async function testUserStatus() {
    logger.info('🧪 Test 7: Exploratory - User Status\n');

    const config = await loadConfig();
    if (!config) {
        throw new Error('Failed to load configuration');
    }

    const client = new CoreSocket(config.foundry);

    try {
        logger.info('📡 Connecting...');
        await client.connect();

        // Wait for async UserStore seeding to complete
        await new Promise(resolve => setTimeout(resolve, 2000));

        logger.info('🔍 Fetching Users...');

        const users = userStore.listWithPresence();

        logger.info(`✅ Fetched ${users.length} Users`);

        logger.info('\n--- User Status Report ---');
        users.forEach((u: any) => {
            logger.info(`User: ${u.name.padEnd(15)} | Active: ${u.active ? '🟢 YES' : '🔴 NO '} | Full: ${JSON.stringify(u)}`);
        });
        logger.info('--------------------------\n');

        // Check if our own user is reported as active
        const myUser = users.find((u: any) => u._id === client.userId || u.id === client.userId);
        if (myUser) {
            logger.info(`👤 Current User (${client.userId}) Active Status: ${myUser.active}`);
        } else {
            logger.warn(`⚠️ Current user ${client.userId} not found in user list!`);
        }

        return { success: true };

    } catch (error: any) {
        logger.error('❌ User status test failed:', error.message);
        return { success: false, error: error.message };
    } finally {
        await client.disconnect();
        logger.info('📡 Disconnected\n');
    }
}

import { fileURLToPath } from 'url';
import { logger } from '@shared/utils/logger';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    testUserStatus().then(result => {
        process.exit(result.success ? 0 : 1);
    });
}
