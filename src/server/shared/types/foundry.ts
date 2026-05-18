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

export interface FoundryClientLike {
    userId?: string | null;
    username?: string;

    on(event: string, handler: (...args: unknown[]) => void): void;
    off(event: string, handler: (...args: unknown[]) => void): void;
}

export interface FoundrySystemClientLike {
    isConnected: boolean;
    worldState: string;
    // Non-document world payload fields moved to WorldStateStore in ADR-0014.
    // These socket-sourced fields are the lifecycle/sync-token leftovers that
    // later phases still need while StatusService is transitional.
    lastActorChange?: string | number;

    resolveUrl(url?: string): string;
}

export interface UserSessionLike {
    id?: string;
    token?: string;
    userId?: string | null;
    username?: string;
    lastActive?: number;
    worldId?: string;
    client: FoundryClientLike;
}

export interface SessionManagerLike {
    isCacheReady(): boolean;
    getOrRestoreSession(token: string): Promise<UserSessionLike | undefined>;
}

export type StatusServiceConfigLike = Pick<AppConfig, 'app' | 'foundry' | 'debug'>;
