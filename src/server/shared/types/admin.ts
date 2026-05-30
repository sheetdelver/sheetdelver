import type { CacheData, WorldData } from '@core/world/SetupManager';

export type WorldEntry = Partial<WorldData>;

export interface AdminStatusClientLike {
    isConnected: boolean;
    userId?: string | null;
    isExplicitSession?: boolean;
    discoveredUserId?: string | null;
    url?: string;
}

export interface AdminServiceDeps {
    getSystemStatusPayload: () => Promise<Record<string, unknown>>;
}

export interface AdminServiceResult {
    getStatus: () => Promise<Record<string, unknown>>;
    listWorlds: () => Promise<WorldEntry[]>;
    getCache: () => Promise<CacheData>;
    launchWorld: (worldId: string) => Promise<{ success: true; message: string }>;
    shutdownWorld: () => Promise<{ success: true; message: string }>;
}
