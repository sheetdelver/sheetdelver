import { getAdapter } from '@modules/registry/server';
import { systemService } from '@core/system/SystemService';
import { SetupManager } from '@core/foundry/SetupManager';
import { UserRole } from '@shared/constants';
import type { SystemStatusPayload } from '@shared/contracts/status';
import type {
    FoundryUserLike,
    FoundrySystemClientLike,
    SessionManagerLike,
    StatusServiceConfigLike,
} from '@server/shared/types/foundry';

interface StatusServiceDeps {
    config: StatusServiceConfigLike;
    sessionManager: Pick<SessionManagerLike, 'isCacheReady'>;
}

export const sanitizeStatusUser = (user: FoundryUserLike, client: FoundrySystemClientLike) => ({
    _id: user._id || user.id,
    name: user.name,
    role: user.role,
    isGM: (user.role || 0) >= UserRole.ASSISTANT,
    active: user.active,
    color: user.color,
    characterId: user.character,
    img: client.resolveUrl(user.avatar || user.img)
});

export function createStatusService(deps: StatusServiceDeps) {
    // Shared user projection used by status payload consumers.
    const sanitizeUser = sanitizeStatusUser;

    // Builds the status contract consumed by REST status and socket broadcasts.
    const getSystemStatusPayload = async (): Promise<SystemStatusPayload> => {
        const systemClient = systemService.getSystemClient() as unknown as FoundrySystemClientLike;
        let system: SystemStatusPayload['system'] = {
            id: null,
            status: systemClient.worldState === 'closed' ? 'closed' : systemClient.worldState,
            worldTitle: 'Reconnecting...'
        };
        let users: FoundryUserLike[] = [];

        try {
            const gameData = systemClient.getGameData();
            if (gameData) {
                const usersList = gameData.users || [];
                const activeCount = usersList.filter((u) => u.active).length;
                const totalCount = usersList.length;

                system = {
                    ...gameData.system,
                    id: gameData.system?.id || null,
                    appVersion: deps.config.app.version,
                    worldTitle: gameData.world?.title || 'Foundry VTT',
                    worldDescription: gameData.world?.description,
                    worldBackground: systemClient.resolveUrl(gameData.world?.background),
                    background: systemClient.resolveUrl(
                        gameData.system?.background ||
                        gameData.system?.worldBackground ||
                        (() => {
                            const sceneData = systemClient.sceneDataCache;
                            return sceneData?.NUEDEFAULTSCENE0?.background?.src;
                        })()
                    ),
                    nextSession: gameData.world?.nextSession,
                    status: systemClient.worldState === 'closed' ? 'closed' : (systemClient.worldState === 'active' ? 'active' : systemClient.worldState),
                    actorSyncToken: systemClient.lastActorChange,
                    users: { active: activeCount, total: totalCount }
                };
                users = usersList;
            } else {
                // No full game data available yet.
                // If the probe discovered the world (service account missing), surface that info.
                const probeData = systemClient.probeWorldData;
                if (probeData) {
                    system.worldTitle = probeData.title || system.worldTitle;
                    system.worldDescription = probeData.description || null;
                    // Surface user count discovered by the guest probe. UserStore is
                    // not seeded yet in this state; probeUserCount preserves the figure
                    // for the closed/probe-only UI surface.
                    const probeTotal = systemClient.probeUserCount ?? 0;
                    system.users = { active: 0, total: probeTotal };
                }
                system.appVersion = deps.config.app.version;
            }

            if (system.id) {
                const sid = String(system.id).toLowerCase();
                const adapter = await getAdapter(sid);
                const configurableAdapter = adapter as unknown as { getConfig?: () => unknown };
                if (configurableAdapter && typeof configurableAdapter.getConfig === 'function') {
                    const cfg = configurableAdapter.getConfig();
                    if (cfg) system.config = cfg;
                }
            }
        } catch {
            // Suppress to preserve status endpoint behavior under partial world availability.
        }

        // Keep payload shape stable by always returning a sanitized user array.
        const sanitizedUsers = users?.length > 0 ? users.map((u) => sanitizeUser(u, systemClient)) : [];

        return {
            connected: systemClient.isConnected,
            worldId: systemClient.getGameData()?.world?.id || null,
            initialized: deps.sessionManager.isCacheReady(),
            isConfigured: !!(systemClient.cachedWorldData || (await SetupManager.loadCache()).currentWorldId),
            users: sanitizedUsers,
            system,
            url: deps.config.foundry.url,
            appVersion: deps.config.app.version,
            debug: deps.config.debug
        };
    };

    return {
        getSystemStatusPayload
    };
}
