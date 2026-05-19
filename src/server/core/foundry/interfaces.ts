import { ServerConnectionStatus } from '@shared/types/connection';

export interface FoundryMetadataClient {
    getAllCompendiumIndices(): Promise<any[]>;
    url: string;
}

export interface FoundryClient extends Partial<FoundryMetadataClient> {
    // Legacy support (to be deprecated or aliased)
    isConnected: boolean;
    isLoggedIn: boolean;
    userId: string | null;

    // Strict Separation
    isSocketConnected: boolean; // Physical socket connection
    isUserAuthenticated: boolean; // User Session

    url: string;
    status: ServerConnectionStatus;

    connect(): Promise<void>;
    disconnect(): void;
    login(username?: string, password?: string): Promise<void>;
    logout(): Promise<void>;

    evaluate<T>(pageFunction: any, arg?: any): Promise<T>;

    getCurrentUserId(): string | null;
    getSystemData(): Promise<any>;
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
