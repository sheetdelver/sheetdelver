
import { CoreSocket } from '../server/core/foundry/sockets/CoreSocket';
import { ClientSocket } from '../server/core/foundry/sockets/ClientSocket';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { logger } from '../shared/utils/logger';
import { resolveDataDir, initDataDir, getConfigFilePath } from '../server/core/paths';

// Set logger to info for visibility
(logger as any).level = 'info';

// Resolve data directory for config access
const dataDir = resolveDataDir(process.argv);
initDataDir(dataDir);

const loadSettings = () => {
    const settingsPath = getConfigFilePath();
    const fileContents = fs.readFileSync(settingsPath, 'utf8');
    return yaml.load(fileContents) as any;
};

const settings = loadSettings();

async function verify() {
    logger.info('=== Architecture Verification ===');

    // 1. Test CoreSocket (Data Hub / Service Account)
    logger.info('\n[1] Initializing CoreSocket...');
    const core = new CoreSocket(settings.foundry);

    try {
        await core.connect();
        logger.info('CoreSocket connected successfully.');
        logger.info('World State:', core.worldState);

        const gameData = core.getGameData();
        logger.info('Game Data loaded:', !!gameData);
        if (gameData) {
            logger.info('World Title:', gameData.world.title);
            logger.info('System:', gameData.system.id);
        }
    } catch (e: any) {
        logger.error('CoreSocket verification failed:', e.message);
        // Don't exit yet, try ClientSocket
    }

    // 2. Test ClientSocket (Auth Anchor / Presence)
    logger.info('\n[2] Initializing ClientSocket...');
    const client = new ClientSocket(settings.foundry, core);

    try {
        // Authenticate
        await client.login();
        logger.info('ClientSocket connected/logged in successfully.');
        logger.info('User ID:', client.userId);

        // Test Proxying
        logger.info('\n[3] Testing Proxying (ClientSocket -> CoreSocket)...');
        const actors = await client.getActors();
        logger.info(`Proxied getActors() count: ${actors.length}`);

        const chat = await client.getChatLog(1);
        logger.info(`Proxied getChatLog() count: ${chat.length}`);
        if (chat.length > 0) {
            logger.info('Latest Message Author:', chat[0].user);
        }

    } catch (e: any) {
        logger.error('ClientSocket verification failed:', e.message);
    }

    logger.info('\n=== Verification Finished ===');

    // Cleanup
    core.disconnect();
    client.disconnect();
    process.exit(0);
}

verify().catch(e => {
    logger.error('Fatal verification error:', e);
    process.exit(1);
});
