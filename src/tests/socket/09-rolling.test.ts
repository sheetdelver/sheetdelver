
import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { createSystemRouteFoundryClient } from '@server/shared/utils/createRouteFoundryClient';
import { fileURLToPath } from 'url';
import { logger } from '@shared/utils/logger';
import {
    bootstrapSocketTestWorld,
    loadSocketTestConfig,
    resetSocketTestWorld,
} from './socket-test-runtime';

export async function testRolling() {
    logger.info('🧪 Test 9: Rolling Functionality\n');

    const config = (await loadSocketTestConfig()).foundry;

    const client = new CoreSocket(config);

    try {
        logger.info('📡 Connecting...');
        await client.connect();
        await bootstrapSocketTestWorld(client);

        // Wait for ready state if needed, though connect() usually handles it
        if (!client.isConnected) throw new Error('Failed to connect');
        const routeClient = createSystemRouteFoundryClient(client);

        // 1. Roll Basic Dice
        logger.info('\n--- Part 1: Basic Roll (1d6) ---');
        const roll1 = await routeClient.roll('1d6', 'Test Roll 1') as any;
        logger.info('Result:', JSON.stringify(roll1, null, 2));

        if (!roll1 || !roll1._id) {
            throw new Error('Roll 1 failed - no ChatMessage created');
        }
        if (roll1.type !== 0 && roll1.type !== 'base') {
            throw new Error(`Roll 1 type mismatch. Expected 0 or 'base', got ${roll1.type}`);
        }

        // 3. Manual / Pre-determined Roll
        logger.info('\n--- Part 3: Manual Roll (Forced Result) ---');
        // We want to test if we can send a roll that has been pre-determined
        // e.g. entering '2' in the dialog should result in '2 + bonuses'
        // For this test, let's see if we can pass a 'manual' flag or if it needs to be the formula
        const roll3 = await routeClient.roll('2', 'Manual Test (Result 2)', {
            displayChat: true
        }) as any;
        logger.info('Result:', JSON.stringify(roll3, null, 2));

        if (!roll3 || roll3.content !== '2') {
            throw new Error(`Manual roll failed. Expected '2', got ${roll3?.content}`);
        }

        logger.info('✅ Rolling Tests Passed');
        return { success: true };

    } catch (error: any) {
        logger.error('❌ Test failed:', error.message);
        return { success: false, error: error.message };
    } finally {
        resetSocketTestWorld();
        if (client.isConnected) {
            await client.disconnect();
            logger.info('📡 Disconnected\n');
        }
    }
}

// Self-execution check
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    testRolling().then(result => {
        process.exit(result.success ? 0 : 1);
    });
}
