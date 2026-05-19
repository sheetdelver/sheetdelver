import { getAdapter } from '@modules/registry/server';
import { systemService } from '@core/system/SystemService';
import { SetupManager } from '@core/world/SetupManager';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { worldLifecycleStore } from '@server/core/world/WorldLifecycleStore';
import { UserRole } from '@shared/constants';
import type { SystemStatusPayload } from '@shared/contracts/status';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import type {
    FoundrySystemClientLike,
    SessionManagerLike,
    StatusServiceConfigLike,
} from '@server/shared/types/foundry';
import type { UserWithPresence } from '@server/shared/types/users';

interface StatusServiceDeps {
    config: StatusServiceConfigLike;
    sessionManager: Pick<SessionManagerLike, 'isCacheReady'>;
}

export const sanitizeStatusUser = (user: Partial<UserWithPresence>, client: Pick<FoundrySystemClientLike, 'resolveUrl'>) => ({
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
        const lifecycleState = worldLifecycleStore.getState();
        // ADR-0014 moved non-document world data/lifecycle into Stores.
        // ADR-0017 moves this Actor/Item sync token out of CoreSocket.
        let system: SystemStatusPayload['system'] = {
            id: null,
            status: lifecycleState === 'closed' ? 'closed' : lifecycleState,
            worldTitle: 'Reconnecting...'
        };
        let users: UserWithPresence[] = [];

        try {
            // Full active-world status is projected from the Store snapshot.
            // The whole snapshot is still used here because status combines
            // world, system, scene, and user summary fields into one contract.
            const gameData = worldStateStore.getGameDataSnapshot();
            if (gameData) {
                const usersList = userStore.isReady() ? userStore.listWithPresence() : [];
                const activeCount = usersList.filter((u) => u.active).length;
                const totalCount = usersList.length;

                system = {
                    ...gameData.system,
                    id: gameData.system?.id || null,
                    version: gameData.system?.version ?? undefined,
                    appVersion: deps.config.app.version,
                    worldTitle: gameData.world?.title || 'Foundry VTT',
                    worldDescription: gameData.world?.description,
                    worldBackground: systemClient.resolveUrl(gameData.world?.background || undefined),
                    background: systemClient.resolveUrl(
                        gameData.system?.background ||
                        gameData.system?.worldBackground ||
                        (() => {
                            // Scene data remains a world-state projection for
                            // now; a later phase may derive this from Scene docs.
                            const sceneData = worldStateStore.getSceneData();
                            return sceneData?.NUEDEFAULTSCENE0?.background?.src;
                        })()
                    ),
                    nextSession: gameData.world?.nextSession,
                    status: lifecycleState === 'closed' ? 'closed' : (lifecycleState === 'active' ? 'active' : lifecycleState),
                    actorSyncToken: systemClient.lastActorChange == null ? undefined : String(systemClient.lastActorChange),
                    users: { active: activeCount, total: totalCount }
                };
                users = usersList;
            } else {
                // No full game data available yet.
                // If the probe discovered the world (service account missing), surface that info.
                const probeData = worldStateStore.getProbeData();
                if (probeData) {
                    system.worldTitle = probeData.title || system.worldTitle;
                    system.worldDescription = probeData.description || null;
                    // Surface user count discovered by the guest probe. UserStore is
                    // not seeded yet in this state; the world Store preserves the figure
                    // for the closed/probe-only UI surface.
                    const probeTotal = worldStateStore.getProbeUserCount();
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
            worldId: worldStateStore.getCurrentWorldId(),
            initialized: deps.sessionManager.isCacheReady(),
            // During setup/offline states, SetupManager's disk cache may be the
            // only known configured-world source, so keep the Store/disk fallback.
            isConfigured: !!(worldStateStore.getCachedWorldData() || (await SetupManager.loadCache()).currentWorldId),
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
