
import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { loadConfig } from '@core/config';
import { worldStateStore } from '@core/world/WorldStateStore';
import { logger } from '@shared/utils/logger';
import fs from 'fs';
import path from 'path';

async function captureWorldData() {
    try {
        const config = await loadConfig();
        const core = new CoreSocket(config.foundry);

        logger.info('Connecting CoreSocket...');
        await core.connect();
        logger.info('CoreSocket connected and authenticated.');

        const gameData = worldStateStore.getGameDataSnapshot();
        if (gameData) {
            const tempDir = path.resolve(process.cwd(), 'temp');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir);
            }

            const outputPath = path.join(tempDir, 'worlddata.json');
            fs.writeFileSync(outputPath, JSON.stringify(gameData, null, 2));
            logger.info(`World data captured and saved to: ${outputPath}`);
        } else {
            logger.error('Failed to retrieve game data from CoreSocket.');
        }

        core.disconnect();
    } catch (e) {
        logger.error(`Error during world data capture: ${e}`);
    }
}

captureWorldData().catch(logger.error);
