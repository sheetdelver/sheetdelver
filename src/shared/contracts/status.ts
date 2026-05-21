import type { AppConfig } from '@shared/interfaces';

export interface StatusUser {
    _id?: string;
    name?: string;
    role?: number;
    isGM?: boolean;
    active?: boolean;
    color?: string;
    characterId?: string | { id?: string; _id?: string } | null;
    img?: string;
}

export type FoundryCompatibilityStatus =
    | 'supported'
    | 'newer-untested'
    | 'unknown'
    | 'unsupported';

export interface FoundryCompatibilityStatusPayload {
    status: FoundryCompatibilityStatus;
    generation: number | null;
    minGeneration: number;
    maxGeneration: number;
    message: string;
    checkedAt: number;
}

export interface SystemStatusPayload {
    connected: boolean;
    worldId: string | null;
    initialized: boolean;
    isConfigured: boolean;
    foundryCompatibility: FoundryCompatibilityStatusPayload | null;
    users: StatusUser[];
    system: {
        id: string | null;
        title?: string;
        version?: string;
        appVersion?: string;
        worldTitle?: string;
        worldDescription?: string | null;
        worldBackground?: string;
        background?: string;
        nextSession?: string | null;
        status?: string;
        actorSyncToken?: string;
        users?: { active: number; total: number };
        config?: unknown;
        [key: string]: unknown;
    };
    url: AppConfig['foundry']['url'];
    appVersion: AppConfig['app']['version'];
    debug: AppConfig['debug'];
}

export interface AuthenticatedStatusPayload extends SystemStatusPayload {
    isAuthenticated: boolean;
    currentUserId: string | null;
}
