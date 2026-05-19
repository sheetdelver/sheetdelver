/// <reference types="node" />
import fs from 'fs';
import yaml from 'js-yaml';
import { CoreSocket } from '../server/core/foundry/sockets/CoreSocket';
import { ClientSocket } from '../server/core/foundry/sockets/ClientSocket';
import { logger } from '../shared/utils/logger';
import { resolveDataDir, initDataDir, getConfigFilePath } from '../server/core/paths';
import { primaryDocumentCacheCoordinator } from '../server/core/documents/primary/PrimaryDocumentCacheCoordinator';
import { worldStateStore } from '../server/core/world/WorldStateStore';
import {
    createSessionRouteFoundryClient,
    createSystemRouteFoundryClient,
} from '../server/shared/utils/createRouteFoundryClient';
import { createChatService } from '../server/services/chat/ChatService';
import { getConfig } from '../server/core/config';

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

    // 1. CoreSocket — service-account data hub. Bootstraps the world cache.
    logger.info('\n[1] Initializing CoreSocket...');
    const core = new CoreSocket(settings.foundry);

    try {
        await core.connect();
        logger.info('CoreSocket connected successfully.');
        logger.info('World State:', core.worldState);

        const gameData = worldStateStore.getGameDataSnapshot();
        logger.info('Game Data loaded:', !!gameData);
        if (gameData) {
            logger.info('World Title:', gameData.world.title);
            logger.info('System:', gameData.system.id);
        }
    } catch (e: any) {
        logger.error('CoreSocket verification failed:', e.message);
        process.exit(1);
    }

    // 2. Seed the primary-document cache via the coordinator. After ADR-0011
    // Phase 8 the seed path is the only way the Stores get populated; nothing
    // else has a socket-shaped Actor / Chat read surface.
    logger.info('\n[2] Seeding primary-document caches via PrimaryDocumentCacheCoordinator...');
    try {
        await primaryDocumentCacheCoordinator.seedAll(core);
        logger.info('All registered primary-document Stores seeded.');
    } catch (e: any) {
        logger.error('Primary-document seed failed:', e.message);
        process.exit(1);
    }

    // 3. ClientSocket — auth anchor / presence channel for a specific user.
    logger.info('\n[3] Initializing ClientSocket...');
    const client = new ClientSocket(settings.foundry, core);

    try {
        await client.login();
        logger.info('ClientSocket connected/logged in successfully.');
        logger.info('User ID:', client.userId);
    } catch (e: any) {
        logger.error('ClientSocket verification failed:', e.message);
        // Continue with system route client only — proxy verification still useful.
    }

    // 4. Verify Store-backed reads through the route-client facade.
    //    The route client is the only allowed Actor / Chat read surface after
    //    ADR-0011 Phase 8. Socket actor helpers no longer exist.
    logger.info('\n[4] Verifying Store-backed reads via the route-client facade...');
    try {
        // Session route client wraps the authenticated ClientSocket when login
        // succeeded; otherwise fall back to the system route client (CoreSocket)
        // for read verification only — writes would require the user socket.
        const routeClient = client.isConnected
            ? createSessionRouteFoundryClient(client, settings.foundry?.username ?? undefined)
            : createSystemRouteFoundryClient(core);

        const actors = await routeClient.getActors();
        logger.info(`Route client getActors() count: ${actors.length}`);

        // Chat reads go through ChatService, which is the Store-backed boundary
        // (ADR-0011 Phase 8 fails closed when ChatMessageStore is cold).
        const chatService = createChatService({ config: getConfig() });
        const { messages } = await chatService.getChatLog(routeClient, 1);
        logger.info(`ChatService getChatLog() count: ${messages.length}`);
        if (messages.length > 0) {
            const latest = messages[0] as Record<string, unknown>;
            logger.info('Latest message:', latest.content ?? latest.user ?? '(no content)');
        }
    } catch (e: any) {
        logger.error('Route-client / Store-backed read verification failed:', e.message);
    }

    logger.info('\n=== Verification Finished ===');

    core.disconnect();
    client.disconnect();
    process.exit(0);
}

verify().catch(e => {
    logger.error('Fatal verification error:', e);
    process.exit(1);
});
