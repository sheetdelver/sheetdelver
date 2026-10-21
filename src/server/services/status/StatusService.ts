import { getAdapter } from '@modules/registry/server';
import { systemService } from '@server/services/world';
import { SetupManager } from '@core/world/SetupManager';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { worldLifecycleStore } from '@server/core/world/WorldLifecycleStore';
import { UserRole } from '@shared/constants';
import { canRoleDeleteActors } from '@shared/security/foundryPermissions';
import { syncTokenService } from '@server/services/status/SyncTokenService';
import { worldBootstrapper } from '@server/services/world';
import type {
    FoundryCompatibilityStatusPayload,
    PublicStatusPayload,
    SystemStatusPayload,
} from '@shared/contracts/status';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import type {
    FoundrySystemClientLike,
    FoundryUserConnectionServiceLike,
    StatusServiceConfigLike,
} from '@server/shared/types/foundry';
import type { UserWithPresence } from '@server/shared/types/users';
import { resolveFoundryUrl } from '@server/shared/utils/foundryUrl';
import { worldWorkGate } from '@server/core/world/WorldWorkGate';

interface StatusServiceDeps {
    config: StatusServiceConfigLike;
    foundryUserConnections: Pick<FoundryUserConnectionServiceLike, 'isCacheReady'>;
    getFoundryCompatibility?: () => FoundryCompatibilityStatusPayload | null;
}

export const sanitizeStatusUser = (user: Partial<UserWithPresence>, foundryBaseUrl: string, serviceAccountId?: string | null) => ({
    _id: user._id || user.id,
    name: user.name,
    role: user.role,
    isGM: (user.role || 0) >= UserRole.ASSISTANT,
    canDeleteActors: canRoleDeleteActors(user.role),
    active: user.active,
    color: user.color,
    characterId: user.character,
    img: resolveFoundryUrl(user.avatar || user.img || '', foundryBaseUrl),
    ...(serviceAccountId && (user._id || user.id) === serviceAccountId ? { isServiceAccount: true } : {}),
});

/**
 * Remove authenticated world and user metadata at the single status boundary.
 * The explicit system allowlist preserves the pre-authentication login display
 * without forwarding the source object's configuration or synchronization data.
 */
export function projectPublicStatus(payload: SystemStatusPayload): PublicStatusPayload {
    return {
        connected: payload.connected,
        initialized: payload.initialized,
        isConfigured: payload.isConfigured,
        foundryCompatibility: payload.foundryCompatibility,
        maintenance: payload.maintenance,
        runtimeToken: payload.runtimeToken,
        users: payload.users
            .filter((user): user is typeof user & { name: string } => typeof user.name === 'string' && user.name.length > 0)
            .map((user) => ({
                name: user.name,
                active: user.active === true,
                // Preserve the existing login policy without disclosing the role.
                canLogin: user.active !== true && user.name !== 'Gamemaster',
            })),
        system: {
            // System identity and presentation are public because the login shell
            // uses them before a Foundry user session can exist.
            id: payload.system.id,
            title: payload.system.title,
            version: payload.system.version,
            worldTitle: payload.system.worldTitle,
            worldDescription: payload.system.worldDescription,
            worldBackground: payload.system.worldBackground,
            ...(payload.system.coreFallbackBackground
                ? { coreFallbackBackground: payload.system.coreFallbackBackground } : {}),
            background: payload.system.background,
            nextSession: payload.system.nextSession,
            status: payload.system.status,
            users: payload.system.users,
            theme: payload.system.theme,
            componentStyles: payload.system.componentStyles,
        },
        appVersion: payload.appVersion,
    };
}

export function createStatusService(deps: StatusServiceDeps) {
    // Shared user projection used by status payload consumers.
    const sanitizeUser = sanitizeStatusUser;
    const getFoundryCompatibility = deps.getFoundryCompatibility ?? (() => worldBootstrapper.getFoundryCompatibility());

    // Builds the status contract consumed by REST status and socket broadcasts.
    const getSystemStatusPayload = async (): Promise<SystemStatusPayload> => {
        const systemClient = systemService.getSystemClient() as unknown as FoundrySystemClientLike;
        const lifecycleState = worldLifecycleStore.getState();
        // ADR-0014 moved non-document world data/lifecycle into Stores.
        // ADR-0017 keeps Actor/Item refresh hints Store-event sourced.
        let system: SystemStatusPayload['system'] = {
            id: null,
            status: lifecycleState === 'closed' ? 'closed' : lifecycleState,
            // No synthetic title: clients use its presence to distinguish a
            // known world starting from Setup with no running world.
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
                    worldBackground: resolveFoundryUrl(gameData.world?.background || '', systemClient.url),
                    coreFallbackBackground: resolveFoundryUrl('ui/backgrounds/setup.webp', systemClient.url),
                    background: resolveFoundryUrl(
                        gameData.system?.background ||
                        gameData.system?.worldBackground ||
                        (() => {
                            // Scene data remains a world-state projection for
                            // now; a later phase may derive this from Scene docs.
                            const sceneData = worldStateStore.getSceneData();
                            return sceneData?.NUEDEFAULTSCENE0?.background?.src;
                        })() ||
                        // Foundry v13/v14 supply this default in CSS, not world data.
                        'ui/backgrounds/setup.webp',
                        systemClient.url
                    ),
                    nextSession: gameData.world?.nextSession,
                    status: lifecycleState === 'closed' ? 'closed' : (lifecycleState === 'active' ? 'active' : lifecycleState),
                    actorSyncToken: syncTokenService.getCurrentToken(),
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

            if (system.id && worldWorkGate.isOpen()) {
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

        // A connected Foundry world is not a successfully prepared SheetDelver world.
        // Publish only the state; source identities and errors remain admin-only.
        const preparationFailed = worldBootstrapper.getBootstrapDiagnostic() !== null;
        if (preparationFailed && lifecycleState !== 'setup' && lifecycleState !== 'closed') system.status = 'unavailable';

        // Keep payload shape stable by always returning a sanitized user array.
        const sanitizedUsers = users?.length > 0
            ? users.map((u) => sanitizeUser(u, systemClient.url, systemClient.userId)) : [];
        const foundryCompatibility = getFoundryCompatibility();

        return {
            connected: systemClient.isConnected,
            worldId: worldStateStore.getCurrentWorldId(),
            initialized: !preparationFailed && worldWorkGate.isOpen() && deps.foundryUserConnections.isCacheReady(),
            maintenance: worldWorkGate.status(),
            runtimeToken: worldWorkGate.getServingToken(),
            // During setup/offline states, SetupManager's disk cache may be the
            // only known configured-world source, so keep the Store/disk fallback.
            isConfigured: !!(worldStateStore.getCachedWorldData() || (await SetupManager.loadCache()).currentWorldId),
            foundryCompatibility: foundryCompatibility ? { ...foundryCompatibility } : null,
            users: sanitizedUsers,
            system,
            url: deps.config.foundry.url,
            appVersion: deps.config.app.version,
            debug: {
                enabled: deps.config.debug.enabled,
                level: deps.config.debug.level,
            }
        };
    };

    return {
        getSystemStatusPayload,
        getPublicStatusPayload: async () => projectPublicStatus(await getSystemStatusPayload()),
    };
}
