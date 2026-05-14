import { logger } from '@shared/utils/logger';
import type { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { actorStore } from './actors/ActorStore';

export async function seedDocumentCache(client: CoreSocket): Promise<void> {
    logger.info('PrimaryDocumentCacheCoordinator | Seeding actor document cache...');
    await actorStore.seed(async () => {
        const response: any = await client.dispatchDocumentSocket('Actor', 'get', { broadcast: false });
        return response?.result || [];
    });
    logger.info(`PrimaryDocumentCacheCoordinator | Seeded ${actorStore.list().length} actors.`);
}

export function clearDocumentCache(reason?: string): void {
    actorStore.clear(reason);
}
