import type { AppConfig, AppSystemInfo } from '@shared/interfaces';

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

/** Minimum roster entry exposed before Foundry authentication. */
export interface PublicStatusUser {
    name: string;
    active: boolean;
    canLogin: boolean;
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
        theme?: AppSystemInfo['theme'];
        componentStyles?: AppSystemInfo['componentStyles'];
        actorSyncToken?: string;
        users?: { active: number; total: number };
        config?: unknown;
        [key: string]: unknown;
    };
    url: AppConfig['foundry']['url'];
    appVersion: AppConfig['app']['version'];
    debug: AppConfig['debug'];
}

/**
 * Availability projection safe for unauthenticated REST and Socket.IO clients.
 * Optional `never` fields document sensitive members intentionally omitted from
 * the wire while keeping client-side narrowing straightforward.
 */
export interface PublicStatusPayload {
    connected: boolean;
    initialized: boolean;
    isConfigured: boolean;
    foundryCompatibility: FoundryCompatibilityStatusPayload | null;
    users: PublicStatusUser[];
    system: {
        id: string | null;
        title?: string;
        version?: string;
        worldTitle?: string;
        worldDescription?: string | null;
        worldBackground?: string;
        background?: string;
        nextSession?: string | null;
        status?: string;
        users?: { active: number; total: number };
        theme?: AppSystemInfo['theme'];
        componentStyles?: AppSystemInfo['componentStyles'];
    };
    appVersion: AppConfig['app']['version'];
    worldId?: never;
    url?: never;
    debug?: never;
}

export interface AuthenticatedStatusPayload extends SystemStatusPayload {
    isAuthenticated: boolean;
    currentUserId: string | null;
}

export type StatusResponsePayload =
    | (PublicStatusPayload & { isAuthenticated: false; currentUserId: null })
    | AuthenticatedStatusPayload;

export type RealtimeStatusPayload = PublicStatusPayload | SystemStatusPayload;
