/**
 * Test: Query TableResult documents directly
 * 
 * This test attempts to fetch TableResult documents for a specific table
 * using different socket API approaches.
 */

import { CoreSocket } from '@core/foundry/sockets/CoreSocket.js';
import { loadConfig } from '@core/config.js';
import { createSystemRouteFoundryClient } from '@server/shared/utils/createRouteFoundryClient';
import { logger } from '@shared/utils/logger';

const TALENT_TABLE_UUID = 'Compendium.shadowdark.rollable-tables.RQ0vogfVtJGuT9oT';

async function main() {
    logger.info('🧪 Test: Query TableResult Documents\n');

    const configLine = await loadConfig();
    if (!configLine) {
        throw new Error('Failed to load configuration');
    }
    const config = configLine.foundry || configLine;

    const client = new CoreSocket(config);

    logger.info('📡 Connecting...');
    await client.connect();

    try {
        const routeClient = createSystemRouteFoundryClient(client);

        // First, fetch the table
        logger.info('\n--- Part 1: Fetch Table ---');
        const table = await routeClient.fetchByUuid(TALENT_TABLE_UUID) as any;
        logger.info('Table Name:', table.name);
        logger.info('Table ID:', table._id);
        logger.info('Result IDs from table:', table.results);

        // Try to query TableResult documents directly
        logger.info('\n--- Part 2: Query TableResult Documents ---');

        // Approach 1: Use dispatchDocumentSocket to query TableResult
        logger.info('\nApproach 1: dispatchDocumentSocket with parent query');
        try {
            const response = await client.dispatchDocumentSocket('TableResult', 'get', {
                query: { parent: table._id },
                broadcast: false
            });
            logger.info('Response:', JSON.stringify(response, null, 2));
        } catch (err: any) {
            logger.info('Failed:', err.message);
        }

        // Approach 2: Try emitSocketEvent with getDocuments
        logger.info('\nApproach 2: emitSocketEvent for TableResult');
        try {
            const response: any = await client.emitSocketEvent('getDocuments', {
                type: 'TableResult',
                operation: { ids: table.results }
            }, 5000);
            logger.info('Response:', JSON.stringify(response, null, 2));
        } catch (err: any) {
            logger.info('Failed:', err.message);
        }

        // Approach 3: Try the embedded UUID shape. ADR-0016 intentionally
        // leaves TableResult rows inside the RollTable payload, so the
        // route-level resolver is expected to return null here.
        logger.info('\nApproach 3: Fetch first result with embedded UUID');
        const firstResultId = table.results[0];
        const embeddedUuid = `${TALENT_TABLE_UUID}.TableResult.${firstResultId}`;
        logger.info('Trying UUID:', embeddedUuid);
        try {
            const result = await routeClient.fetchByUuid(embeddedUuid);
            logger.info('Result:', JSON.stringify(result, null, 2));
        } catch (err: any) {
            logger.info('Failed:', err.message);
        }

    } finally {
        await client.disconnect();
        logger.info('📡 Disconnected');
    }
}

main().catch(logger.error);
