import type { AppConfig } from '@shared/interfaces';

export interface FoundryUserLike {
    id?: string;
    _id?: string;
    name?: string;
    role?: number;
    active?: boolean;
    color?: string;
    avatar?: string;
    img?: string;
    character?: string | { id?: string; _id?: string } | null;
}

export interface FoundryWorldLike {
    id?: string;
    title?: string;
    description?: string | null;
    background?: string;
    nextSession?: string | null;
}

export interface FoundrySystemLike {
    id?: string;
    background?: string;
    worldBackground?: string;
    [key: string]: unknown;
}

export interface FoundryGameDataLike {
    world?: FoundryWorldLike;
    system?: FoundrySystemLike;
    users?: FoundryUserLike[];
}

export type FoundryEventHandler = (...args: unknown[]) => void;

export interface FoundryClientLike {
    userId?: string | null;

    on(event: string, handler: FoundryEventHandler): void;
    off(event: string, handler: FoundryEventHandler): void;
}

export interface FoundryDocumentClientLike extends FoundryClientLike {
    isConnected: boolean;
    url: string;
    dispatchDocument(
        type: string,
        action: string,
        operation?: unknown,
        parent?: { type: string; id: string }
    ): Promise<unknown>;
    dispatchDocumentSocket(
        type: string,
        action: string,
        operation?: unknown,
        parent?: unknown,
        failHard?: boolean
    ): Promise<unknown>;
}

export interface FoundryCompendiumClientLike extends FoundryDocumentClientLike {
    emitSocketEvent<T>(event: string, ...payloads: unknown[]): Promise<T>;
    withHeartbeatPaused?<T>(operation: () => Promise<T>): Promise<T>;
}

export interface RestoredFoundrySessionCredential {
    userId: string;
    cookie: string;
}

export interface FoundrySystemClientLike {
    isConnected: boolean;
    url: string;
}

export interface FoundryUserConnectionLike {
    id?: string;
    token?: string;
    userId?: string | null;
    username?: string;
    lastActive?: number;
    worldId?: string;
    client: FoundryDocumentClientLike;
}

export type FoundrySessionInvalidationReason =
    | 'revoked'
    | 'replaced'
    | 'expired'
    | 'world-mismatch'
    | 'invalid-record'
    | 'world-entered-setup'
    | 'user-deleted';

/** Server-only signal used to retire already-connected app socket authority. */
export type FoundrySessionInvalidationEvent =
    | {
        scope: 'session';
        sessionId: string;
        reason: FoundrySessionInvalidationReason;
    }
    | {
        scope: 'all';
        reason: FoundrySessionInvalidationReason;
    };

export type FoundrySessionInvalidationListener = (
    event: FoundrySessionInvalidationEvent,
) => void;

export interface FoundryUserConnectionServiceLike {
    isCacheReady(): boolean;
    createSession(username: string, password?: string): Promise<{ sessionId: string; userId: string }>;
    getOrRestoreSession(token: string): Promise<FoundryUserConnectionLike | undefined>;
    destroySession(token: string): Promise<void>;
    isValidSession(token: string): boolean;
    onSessionInvalidated(listener: FoundrySessionInvalidationListener): () => void;
}

export type StatusServiceConfigLike = Pick<AppConfig, 'app' | 'foundry' | 'debug'>;
