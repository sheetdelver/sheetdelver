import { logger } from '@shared/utils/logger';
import type { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import type { PrimaryDocumentType } from './base/PrimaryDocumentStore';
import { modifyDocumentRouter } from './base/modifyDocumentRouter';
import { actorStore } from './actors/ActorStore';
import { chatMessageStore } from './chat-messages/ChatMessageStore';
import { combatStore } from './combats/CombatStore';
import { folderStore } from './folders/FolderStore';
import { cardsStore } from './cards/CardsStore';
import { itemStore } from './items/ItemStore';
import { journalStore } from './journals/JournalStore';
import { macroStore } from './macros/MacroStore';
import { playlistStore } from './playlists/PlaylistStore';
import { rollTableStore } from './roll-tables/RollTableStore';
import { userStore } from './users/UserStore';

/**
 * One bootstrap-seed contributor. Registered with the coordinator so the
 * WorldBootstrapper path doesn't grow per-type knowledge.
 */
export interface PrimaryDocumentSeeder {
    type: PrimaryDocumentType;
    seed(client: CoreSocket): Promise<void>;
    clear(reason?: string): void;
    isReady(): boolean;
}

/**
 * Coordinator for primary-document cache lifecycle. Per ADR-0011, individual
 * Stores register themselves here at module init; WorldBootstrapper.bootstrap()
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

primaryDocumentCacheCoordinator.register({
    type: 'Folder',
    async seed(client) {
        await folderStore.seed(async () => {
            const response: any = await client.dispatchDocumentSocket('Folder', 'get', { broadcast: false });
            return response?.result || [];
        });
        logger.info(`PrimaryDocumentCacheCoordinator | Seeded ${folderStore.list().length} folders.`);
    },
    clear(reason) {
        folderStore.clear(reason);
    },
    isReady() {
        return folderStore.isReady();
    },
});

primaryDocumentCacheCoordinator.register({
    type: 'User',
    async seed(client) {
        await userStore.seed(async () => {
            // Foundry's `User.get` returns the full roster. Per ADR-0013 user docs
            // carry no per-user ownership map; presence (`active`) is delivered
            // separately by `userConnected` / `userDisconnected` socket events.
            const response: any = await client.dispatchDocumentSocket('User', 'get', { broadcast: false });
            return response?.result || [];
        });
        logger.info(`PrimaryDocumentCacheCoordinator | Seeded ${userStore.list().length} users.`);
    },
    clear(reason) {
        userStore.clear(reason);
    },
    isReady() {
        return userStore.isReady();
    },
});

// JournalStore seeds after FolderStore so folder-organized list projection has
// the folder tree available immediately. JournalStore does not hold folder
// docs; it joins entry.folder against FolderStore at projection time.
primaryDocumentCacheCoordinator.register({
    type: 'JournalEntry',
    async seed(client) {
        await journalStore.seed(async () => {
            const response: any = await client.dispatchDocumentSocket('JournalEntry', 'get', { broadcast: false });
            return response?.result || [];
        });
        logger.info(`PrimaryDocumentCacheCoordinator | Seeded ${journalStore.list().length} journals.`);
    },
    clear(reason) {
        journalStore.clear(reason);
    },
    isReady() {
        return journalStore.isReady();
    },
});

// ItemStore seeds after FolderStore so a future folder-organized item view
// can join `item.folder` against `FolderStore` without races. Items use the
// standard `ownership` map (no cross-store visibility dependency); the embedded
// `ActiveEffect` handler under `Item.<id>` is registered separately below.
primaryDocumentCacheCoordinator.register({
    type: 'Item',
    async seed(client) {
        await itemStore.seed(async () => {
            const response: any = await client.dispatchDocumentSocket('Item', 'get', { broadcast: false });
            return response?.result || [];
        });
        logger.info(`PrimaryDocumentCacheCoordinator | Seeded ${itemStore.list().length} world items.`);
    },
    clear(reason) {
        itemStore.clear(reason);
    },
    isReady() {
        return itemStore.isReady();
    },
});

// CombatStore seeds after ActorStore so combat visibility resolution against
// ActorStore has actors available immediately. Combat docs carry no ownership
// map; visibility derives from combatant.actorId cross-referenced against
// `actorStore.canReadActor` (see `CombatStore.resolveOwnership`).
primaryDocumentCacheCoordinator.register({
    type: 'Combat',
    async seed(client) {
        await combatStore.seed(async () => {
            const response: any = await client.dispatchDocumentSocket('Combat', 'get', { broadcast: false });
            return response?.result || [];
        });
        logger.info(`PrimaryDocumentCacheCoordinator | Seeded ${combatStore.list().length} combats.`);
    },
    clear(reason) {
        combatStore.clear(reason);
    },
    isReady() {
        return combatStore.isReady();
    },
});

// RollTableStore — standard ownership map; embedded `RollTableResult` events
// flow via `parentUuid: RollTable.<id>` (handler registered below).
primaryDocumentCacheCoordinator.register({
    type: 'RollTable',
    async seed(client) {
        await rollTableStore.seed(async () => {
            const response: any = await client.dispatchDocumentSocket('RollTable', 'get', { broadcast: false });
            return response?.result || [];
        });
        logger.info(`PrimaryDocumentCacheCoordinator | Seeded ${rollTableStore.list().length} roll tables.`);
    },
    clear(reason) {
        rollTableStore.clear(reason);
    },
    isReady() {
        return rollTableStore.isReady();
    },
});

// MacroStore — standard ownership map; no embedded children. `author` field
// is creator attribution, not part of ownership resolution.
primaryDocumentCacheCoordinator.register({
    type: 'Macro',
    async seed(client) {
        await macroStore.seed(async () => {
            const response: any = await client.dispatchDocumentSocket('Macro', 'get', { broadcast: false });
            return response?.result || [];
        });
        logger.info(`PrimaryDocumentCacheCoordinator | Seeded ${macroStore.list().length} macros.`);
    },
    clear(reason) {
        macroStore.clear(reason);
    },
    isReady() {
        return macroStore.isReady();
    },
});

// PlaylistStore — standard ownership map; embedded `PlaylistSound` events
// flow via `parentUuid: Playlist.<id>` (handler registered below).
primaryDocumentCacheCoordinator.register({
    type: 'Playlist',
    async seed(client) {
        await playlistStore.seed(async () => {
            const response: any = await client.dispatchDocumentSocket('Playlist', 'get', { broadcast: false });
            return response?.result || [];
        });
        logger.info(`PrimaryDocumentCacheCoordinator | Seeded ${playlistStore.list().length} playlists.`);
    },
    clear(reason) {
        playlistStore.clear(reason);
    },
    isReady() {
        return playlistStore.isReady();
    },
});

// CardsStore — standard ownership map; embedded `Card` events flow via
// `parentUuid: Cards.<id>` (handler registered below). Cross-Cards-doc
// transfers (`Cards#pass`) arrive as paired update/delete legs on both parents.
primaryDocumentCacheCoordinator.register({
    type: 'Cards',
    async seed(client) {
        await cardsStore.seed(async () => {
            const response: any = await client.dispatchDocumentSocket('Cards', 'get', { broadcast: false });
            return response?.result || [];
        });
        logger.info(`PrimaryDocumentCacheCoordinator | Seeded ${cardsStore.list().length} cards docs.`);
    },
    clear(reason) {
        cardsStore.clear(reason);
    },
    isReady() {
        return cardsStore.isReady();
    },
});

// modifyDocument router bindings
modifyDocumentRouter.register(actorStore);
modifyDocumentRouter.register(chatMessageStore);
modifyDocumentRouter.register(folderStore);
modifyDocumentRouter.register(userStore);
modifyDocumentRouter.register(journalStore);
modifyDocumentRouter.register(combatStore);
modifyDocumentRouter.register(itemStore);
modifyDocumentRouter.register(rollTableStore);
modifyDocumentRouter.register(macroStore);
modifyDocumentRouter.register(playlistStore);
modifyDocumentRouter.register(cardsStore);
// Embedded children: Actor owns Item + ActiveEffect with parentUuid 'Actor.xxx...'.
// The router's parentUuid-first priority (ADR-0011 Phase 6) keeps these on
// ActorStore even though ItemStore is now registered for direct-type `Item`.
modifyDocumentRouter.registerEmbeddedHandler('Actor', actorStore);
// JournalEntry owns JournalEntryPage with parentUuid 'JournalEntry.<id>'.
modifyDocumentRouter.registerEmbeddedHandler('JournalEntry', journalStore);
// Combat owns Combatant with parentUuid 'Combat.<id>'.
modifyDocumentRouter.registerEmbeddedHandler('Combat', combatStore);
// Item owns ActiveEffect with parentUuid 'Item.<id>' (world-Item effects only;
// actor-owned item effects still flow through ActorStore via 'Actor.<id>.Item.<id>').
modifyDocumentRouter.registerEmbeddedHandler('Item', itemStore);
// RollTable owns RollTableResult with parentUuid 'RollTable.<id>'.
modifyDocumentRouter.registerEmbeddedHandler('RollTable', rollTableStore);
// Playlist owns PlaylistSound with parentUuid 'Playlist.<id>'.
modifyDocumentRouter.registerEmbeddedHandler('Playlist', playlistStore);
// Cards owns Card with parentUuid 'Cards.<id>'. Cross-Cards-doc transfers
// arrive as paired events on two parents; each leg lands here for its parent.
modifyDocumentRouter.registerEmbeddedHandler('Cards', cardsStore);

// Cross-store visibility dependency (ADR-0011 Phase 5): CombatStore consumes
// ActorStore for `resolveOwnership` lookups and re-emits its own list
// invalidation when actor ownership crossings affect combat visibility.
combatStore.bindActorVisibilityBridge(actorStore);

/**
 * @deprecated Use {@link primaryDocumentCacheCoordinator}.seedAll(client) directly.
 * Preserved for backward compat with `WorldBootstrapper.bootstrap()`.
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
