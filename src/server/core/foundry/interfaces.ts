import type {
    FoundryCompendiumClientLike,
    FoundryDocumentClientLike,
    RestoredFoundrySessionCredential,
} from '@server/shared/types/foundry';

export interface FoundryUserTransportClient extends FoundryDocumentClientLike {
    isSocketConnected: boolean;
    login(username?: string, password?: string): Promise<void>;
    logout(): Promise<void>;
    connect(): Promise<void>;
    disconnect(): void;
    connectWithRestoredCredential(credential: RestoredFoundrySessionCredential): Promise<void>;
    getSessionCookie(): string | null;
}

export interface FoundrySystemTransportClient extends FoundryCompendiumClientLike {
    isSocketConnected: boolean;
    connect(): Promise<void>;
    disconnect(): void;
    logout(): Promise<void>;
    startRuntimeHeartbeat(): void;
}

export type FoundryClient = FoundryUserTransportClient;
