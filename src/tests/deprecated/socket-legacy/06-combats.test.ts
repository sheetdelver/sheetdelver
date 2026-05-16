import { ClientSocket } from '@core/foundry/sockets/ClientSocket';
import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { loadConfig } from '@core/config';
import 'dotenv/config';
import { logger } from '@shared/utils/logger';
import { combatStore } from '@server/core/documents/primary/combats/CombatStore';

// Force test env (Ignore read-only error for test script)
// @ts-ignore
process.env.NODE_ENV = 'test';

async function testCombats() {
    logger.info('🧪 Test 6: Combats Endpoint Verification');

    const config = await loadConfig();
    if (!config) {
        logger.error('❌ Could not load config');
        process.exit(1);
    }

    // Initialize Stack
    const core = new CoreSocket(config.foundry);
    const client = new ClientSocket(config.foundry, core);

    try {
        logger.info('📡 Connecting...');
        // Connect Core Socket (Actual connection)
        await core.connect();

        // ClientSocket doesn't need explicit connect, but we might want to ensure it's "ready"

        // Login as player (doratheexplorer) to test permissions
        // or GM? Let's use the config default (which was doratheexplorer in previous tests)
        logger.info(`👤 Identifying as: ${(client as any).config.username}`);

        // 1. List (Store-backed)
        logger.info('📚 Fetching Combats...');
        await combatStore.seed(async () => {
            const response = await core.dispatchDocumentSocket('Combat', 'get', { broadcast: false });
            return response?.result || [];
        });
        const combats = combatStore.list();
        logger.info(`✅ Fetched ${combats.length} Combats`);
        const combat = combats[0];
        logger.info(JSON.stringify(combat, null, 2));


        logger.info('👥 Fetching Actors...');
        const actors = await client.getActors();
        logger.info(`✅ Fetched ${actors.length} Actors`);
        logger.info('👥 Fetching combatants...')
        for (const combatant of combat.combatants.sort((c: any, d: any) => d.initiative - c.initiative)) {
            const user = actors.find((actor: any) => actor._id === combatant.actorId);
            logger.info(`✅ Fetched ${user.name} Initiative: ${combatant.initiative}`);
        }
        logger.info('✅ Fetching combatants Success!')

        client.disconnect();
        core.disconnect();
        process.exit(0);

    } catch (e) {
        logger.error('❌ Test Failed:', e);
        client.disconnect();
        core.disconnect();
        process.exit(1);
    }
}

testCombats();
