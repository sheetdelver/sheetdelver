import { DirectScraper } from '@core/foundry/DirectScraper';
import { SetupManager, WorldData } from '@core/world/SetupManager';
import path from 'path';
import fs from 'fs';
import { logger } from '@shared/utils/logger';

async function main() {
    const args = process.argv.slice(2);
    const dataPathArg = args[0];
    if (!dataPathArg) {
        logger.error('\x1b[31mError:\x1b[0m Please provide paths to the Foundry Data directory.');
        logger.info('Usage: npm run admin:import <FoundryDataPath>');
        logger.info('Example: npm run admin:import /home/user/.local/share/FoundryVTT/Data');
        process.exit(1);
    }

    const resolvedPath = path.resolve(process.cwd(), dataPathArg);
    if (!fs.existsSync(resolvedPath)) {
        logger.error(`\x1b[31mError:\x1b[0m Path not found: ${resolvedPath}`);
        process.exit(1);
    }

    logger.info(`\x1b[36mRunning Direct Batch Import on:\x1b[0m ${resolvedPath}`);
    try {
        logger.info('Discovering worlds...');
        const worlds = await DirectScraper.discover(resolvedPath);

        if (worlds.length === 0) {
            logger.info('\x1b[33mNo worlds found in that directory.\x1b[0m');
            process.exit(0);
        }

        logger.info(`Found ${worlds.length} worlds. Importing...`);
        const cacheUpdates: WorldData[] = [];

        for (const world of worlds) {
            try {
                logger.info(` - Scraping ${world.title} (${world.id})...`);
                const data = await DirectScraper.scrape(world.path);

                cacheUpdates.push({
                    worldId: data.id,
                    worldTitle: data.title,
                    worldDescription: data.description,
                    systemId: data.system,
                    backgroundUrl: data.background,
                    users: data.users.map(u => ({ _id: u.id, name: u.name, role: u.role })),
                    lastUpdated: new Date().toISOString(),
                    data: { ...data }
                });
            } catch (err: any) {
                logger.error(`   \x1b[31mFailed to scrape ${world.id}:\x1b[0m ${err.message}`);
            }
        }

        if (cacheUpdates.length > 0) {
            await SetupManager.saveBatchCache(cacheUpdates);
            logger.info(`\n\x1b[32mSuccessfully imported ${cacheUpdates.length}/${worlds.length} worlds.\x1b[0m`);
            logger.info(`\x1b[33mCache updated. Application will hot-reload if running.\x1b[0m\n`);
        } else {
            logger.info('\n\x1b[31mNo worlds were successfully imported.\x1b[0m\n');
            process.exit(1);
        }
        process.exit(0);
    } catch (e: any) {
        logger.error(`\x1b[31mImport Failed:\x1b[0m ${e.message}`);
        process.exit(1);
    }
}

main().catch(err => {
    logger.error('Fatal CLI Error:', err);
    process.exit(1);
});
