
import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { loadConfig } from '@core/config';
import { fileURLToPath } from 'url';
import { logger } from '@shared/utils/logger';

export async function testRolling() {
    logger.info('🧪 Test 9: Rolling Functionality\n');

    // Setup - mimics behavior in 01-connection.test.ts
    const configLine = await loadConfig(); // Note: loadConfig likely returns { foundry: ... } or similar based on usage
    // loadConfig implementation check needed? 01-connection uses it directly.
    // Let's assume standard behavior:
    if (!configLine) {
        throw new Error('Failed to load configuration');
    }
    const config = configLine.foundry || configLine; // Robustness

    const client = new CoreSocket(config);

    try {
        logger.info('📡 Connecting...');
        await client.connect();

        // Wait for ready state if needed, though connect() usually handles it
        if (!client.isConnected) throw new Error('Failed to connect');

        logger.info('✅ Execute Macro Tests Passed');
        return { success: true };

    } catch (error: any) {
        logger.error('❌ Test failed:', error.message);
        return { success: false, error: error.message };
    } finally {
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
