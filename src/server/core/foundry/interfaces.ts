import { ServerConnectionStatus } from '@shared/types/connection';
import { FoundrySystemMeta } from '@shared/interfaces';
import type { WorldLifecycleState } from '@server/core/world/WorldLifecycleStore';

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
    // Compatibility read only. Use WorldLifecycleStore for lifecycle ownership.
    worldState: WorldLifecycleState;
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
    getSystemConfig(): Promise<any>;
    getSystemAdapter(): any;

    // Removed getAllCompendiumIndices from base FoundryClient for user-level sockets
    // It is now in FoundryMetadataClient (implemented by CoreSocket)

    dispatchDocument(type: string, action: string, operation?: any, parent?: { type: string, id: string }): Promise<any>;
    dispatchDocumentSocket(type: string, action: string, data?: any, parent?: any): Promise<any>;
    getAllCompendiumIndices(): Promise<any[]>;
    fetchByUuid(uuid: string): Promise<any>;

    // World Management (Admin CLI)
    getWorlds(): Promise<any[]>;
    launchWorld(worldId: string): Promise<void>;
    shutdownWorld(): Promise<void>;
}
