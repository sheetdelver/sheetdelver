import { ServerConnectionStatus } from '@shared/types/connection';
import { FoundrySystemMeta } from '@shared/interfaces';

export type { FoundrySystemMeta };

export interface FoundryMetadataClient {
    getAllCompendiumIndices(): Promise<any[]>;
    getSystem(): Promise<FoundrySystemMeta>;
    url: string;
}

export interface FoundryClient extends Partial<FoundryMetadataClient> {
    // Legacy support (to be deprecated or aliased)
    isConnected: boolean;
    isLoggedIn: boolean;
    userId: string | null;

    // Strict Separation
    isSocketConnected: boolean; // Physical socket connection
    worldState: 'offline' | 'setup' | 'active'; // World Availability
    isUserAuthenticated: boolean; // User Session

    url: string;
    status: ServerConnectionStatus;

    connect(): Promise<void>;
    disconnect(): void;
    login(username?: string, password?: string): Promise<void>;
    logout(): Promise<void>;

    evaluate<T>(pageFunction: any, arg?: any): Promise<T>;

    getSystem(): Promise<FoundrySystemMeta>;
    getCurrentUserId(): string | null;
    getSystemData(): Promise<any>;
    getActors(): Promise<any[]>;
    getActor(id: string, forceSystemId?: string): Promise<any>;
    getActorRaw(id: string): Promise<any>;
    getSystemConfig(): Promise<any>;
    getSystemAdapter(): any;

    // Removed getAllCompendiumIndices from base FoundryClient for user-level sockets
    // It is now in FoundryMetadataClient (implemented by CoreSocket)

    updateActor(id: string, data: any): Promise<any>;
    createActor(data: any): Promise<any>;
    deleteActor(id: string): Promise<any>;

    createActorItem(actorId: string, itemData: any): Promise<any>;
    updateActorItem(actorId: string, itemData: any): Promise<any>;
    deleteActorItem(actorId: string, itemId: string): Promise<any>;

    dispatchDocument(type: string, action: string, operation?: any, parent?: { type: string, id: string }): Promise<any>;
    dispatchDocumentSocket(type: string, action: string, data?: any, parent?: any): Promise<any>;
    getAllCompendiumIndices(): Promise<any[]>;
    fetchByUuid(uuid: string): Promise<any>;

    getChatLog(limit?: number): Promise<any[]>;

    useItem(actorId: string, itemId: string): Promise<any>;
    roll(formula: string, flavor?: string, options?: { rollMode?: string, speaker?: any }): Promise<any>;

    // World Management (Admin CLI)
    getWorlds(): Promise<any[]>;
    launchWorld(worldId: string): Promise<void>;
    shutdownWorld(): Promise<void>;
}
