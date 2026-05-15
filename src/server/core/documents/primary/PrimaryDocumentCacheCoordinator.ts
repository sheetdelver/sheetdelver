import { logger } from '@shared/utils/logger';
import type { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import type { PrimaryDocumentType } from './base/PrimaryDocumentStore';
import { modifyDocumentRouter } from './base/modifyDocumentRouter';
import { actorStore } from './actors/ActorStore';
import { chatMessageStore } from './chat-messages/ChatMessageStore';

/**
 * One bootstrap-seed contributor. Registered with the coordinator so the
 * SystemService.bootstrap path doesn't grow per-type knowledge.
 */
export interface PrimaryDocumentSeeder {
    type: PrimaryDocumentType;
    seed(client: CoreSocket): Promise<void>;
    clear(reason?: string): void;
    isReady(): boolean;
}

/**
 * Coordinator for primary-document cache lifecycle. Per ADR-0011, individual
 * Stores register themselves here at module init; SystemService.bootstrap()
 * calls `seedAll` and treats failure as bootstrap failure (no readiness signal).
 */
class PrimaryDocumentCacheCoordinator {
    private seeders: PrimaryDocumentSeeder[] = [];

    register(seeder: PrimaryDocumentSeeder): void {
        this.seeders.push(seeder);
    }

    async seedAll(client: CoreSocket): Promise<void> {
        for (const seeder of this.seeders) {
            logger.info(`PrimaryDocumentCacheCoordinator | Seeding ${seeder.type}...`);
            await seeder.seed(client);
        }
    }

    clearAll(reason?: string): void {
        for (const seeder of this.seeders) {
            seeder.clear(reason);
        }
    }

    isDocumentCacheReady(type?: PrimaryDocumentType): boolean {
        if (!type) return this.seeders.every(s => s.isReady());
        const seeder = this.seeders.find(s => s.type === type);
        return seeder ? seeder.isReady() : false;
    }
}

export const primaryDocumentCacheCoordinator = new PrimaryDocumentCacheCoordinator();

// -----------------------------------------------------------------------------
// Built-in Store registrations
//
// Each Store registers its bootstrap seeder and binds into the modifyDocument
// router so inbound Foundry broadcasts route to the correct subsystem.
// Adding a new primary-doc Store means: register the seeder here, register the
// router binding, done. No changes needed in SystemService or CoreSocket.
// -----------------------------------------------------------------------------

primaryDocumentCacheCoordinator.register({
    type: 'Actor',
    async seed(client) {
        await actorStore.seed(async () => {
            const response: any = await client.dispatchDocumentSocket('Actor', 'get', { broadcast: false });
            return response?.result || [];
        });
        logger.info(`PrimaryDocumentCacheCoordinator | Seeded ${actorStore.list().length} actors.`);
    },
    clear(reason) {
        actorStore.clear(reason);
    },
    isReady() {
        return actorStore.isReady();
    },
});

primaryDocumentCacheCoordinator.register({
    type: 'ChatMessage',
    async seed(client) {
        await chatMessageStore.seed(async () => {
            const response: any = await client.dispatchDocumentSocket('ChatMessage', 'get', { broadcast: false });
            return response?.result || [];
        });
        logger.info(`PrimaryDocumentCacheCoordinator | Seeded ${chatMessageStore.list().length} chat messages.`);
    },
    clear(reason) {
        chatMessageStore.clear(reason);
    },
    isReady() {
        return chatMessageStore.isReady();
    },
});

// modifyDocument router bindings
modifyDocumentRouter.register(actorStore);
modifyDocumentRouter.register(chatMessageStore);
// Embedded children: Actor owns Item + ActiveEffect with parentUuid 'Actor.xxx...'.
modifyDocumentRouter.registerEmbeddedHandler('Actor', actorStore);

/**
 * @deprecated Use {@link primaryDocumentCacheCoordinator}.seedAll(client) directly.
 * Preserved for backward compat with `SystemService.bootstrap()`.
 */
export async function seedDocumentCache(client: CoreSocket): Promise<void> {
    await primaryDocumentCacheCoordinator.seedAll(client);
}

/**
 * @deprecated Use {@link primaryDocumentCacheCoordinator}.clearAll(reason) directly.
 * Preserved for backward compat with `SystemService.handleDisconnect()`.
 */
export function clearDocumentCache(reason?: string): void {
    primaryDocumentCacheCoordinator.clearAll(reason);
}
