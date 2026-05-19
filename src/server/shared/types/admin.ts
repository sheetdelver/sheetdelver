import type { CacheData, WorldData } from '@core/world/SetupManager';

export type WorldEntry = Partial<WorldData>;

export interface AdminStatusClientLike {
    isConnected: boolean;
    userId?: string | null;
    isExplicitSession?: boolean;
    discoveredUserId?: string | null;
    url?: string;
    launchWorld(worldId: string): Promise<void>;
    shutdownWorld(): Promise<void>;
}

export interface AdminServiceDeps {
    getSystemStatusPayload: () => Promise<Record<string, unknown>>;
}

export interface AdminServiceResult {
    getStatus: () => Promise<Record<string, unknown>>;
    listWorlds: () => Promise<WorldEntry[]>;
    getCache: () => Promise<CacheData>;
    scrapeSetup: (sessionCookie: string) => Promise<Record<string, unknown>>;
    launchWorld: (worldId: string) => Promise<{ success: true; message: string }>;
    shutdownWorld: () => Promise<{ success: true; message: string }>;
}
