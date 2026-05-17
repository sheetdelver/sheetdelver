
import { SessionManager } from '@core/session/SessionManager';
import { loadConfig } from '@core/config';
import { createSessionRouteFoundryClient } from '@server/shared/utils/createRouteFoundryClient';
import readline from 'readline';
import { logger } from '@shared/utils/logger';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question: string): Promise<string> {
    return new Promise((resolve) => rl.question(question, resolve));
}

async function testSessionPersistence() {
    logger.info('🧪 Test 8: Session Persistence and Restoration\n');

    const config = await loadConfig();
    if (!config) {
        throw new Error('Failed to load configuration');
    }

    const sessionManager = new SessionManager(config.foundry);

    try {
        logger.info('8a. Initializing SessionManager (connecting system socket)...');
        await sessionManager.initialize();

        const username = await ask('Enter Foundry Username: ');
        const password = await ask('Enter Foundry Password: ');

        logger.info(`\n8b. Creating session for "${username}"...`);
        const { sessionId, userId } = await sessionManager.createSession(username, password);

        logger.info(`✅ Session created. ID: ${sessionId}, UserID: ${userId}`);

        const session = await sessionManager.getOrRestoreSession(sessionId);
        if (!session) throw new Error('Session not found after creation');

        logger.info('8c. Verifying data fetch (Actors)...');
        const routeClient = createSessionRouteFoundryClient(session.client, session.username);
        const actors = await routeClient.getActors();
        logger.info(`   ✅ Fetched ${actors.length} actors.`);

        logger.info('\n8d. Simulating Server Restart (clearing in-memory sessions)...');
        // @ts-ignore - reaching into private map for testing
        sessionManager.sessions.clear();

        logger.info('8e. Attempting to restore session from disk...');
        const restoredSession = await sessionManager.getOrRestoreSession(sessionId);

        if (restoredSession) {
            logger.info('   ✅ Session restored successfully.');

            logger.info('8f. Verifying data fetch with restored session...');
            const restoredRouteClient = createSessionRouteFoundryClient(restoredSession.client, restoredSession.username);
            const restoredActors = await restoredRouteClient.getActors();
            logger.info(`   ✅ Fetched ${restoredActors.length} actors with restored session.`);

            if (restoredActors.length === actors.length) {
                logger.info('   ✅ Actor count matches.');
            } else {
                logger.warn('   ⚠️ Actor count mismatch (might be expected if world changed).');
            }
        } else {
            throw new Error('Failed to restore session from disk');
        }

        logger.info('\n📊 Test Passed');
        process.exit(0);

    } catch (error: any) {
        logger.error('\n❌ Test failed:', error.message);
        process.exit(1);
    } finally {
        rl.close();
    }
}

testSessionPersistence();
