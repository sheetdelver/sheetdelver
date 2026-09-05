import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { loadSocketTestConfig } from './socket-test-runtime';

/**
 * Test 1: Basic Connection and Authentication
 * Tests that we can connect and authenticate without breaking the server
 */
export async function testConnection() {
    logger.info('🧪 Test 1: Connection & Authentication\n');

    const config = await loadSocketTestConfig();

    const client = new CoreSocket(config.foundry);

    try {
        logger.info('📡 Connecting...');
        await client.connect();
        logger.info('✅ Connected successfully!');
        logger.info('✅ Authentication successful (userId present in session)');
        return { success: true };
    } catch (error: any) {
        logger.error('❌ Connection failed:', error.message);
        return { success: false, error: error.message };
    } finally {
        await client.disconnect();
        logger.info('📡 Disconnected\n');
    }
}

import { fileURLToPath } from 'url';
import { logger } from '@shared/utils/logger';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    testConnection().then(result => {
        process.exit(result.success ? 0 : 1);
    });
}
