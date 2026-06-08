import { getServerModule as getRegisteredServerModule } from '@modules/registry/server';
import { logger } from '@shared/utils/logger';
import { createModuleRuntime } from '@server/shared/utils/createModuleRuntime';
import { createModuleRequestRuntime } from '@server/shared/utils/moduleDocumentServices';
import { SdkError } from '@shared/sdk';
import type { ModuleAccessContext, ModuleRuntime } from '@shared/sdk/runtime';
import type { UserSession } from '@shared/sdk/contracts';
import type {
    ModuleProxyDispatchRequest,
    ModuleProxyDispatchResult,
    ModuleServerLike,
    NextLikeResponse,
} from '@server/shared/types/moduleProxy';
import type { FoundryUserConnectionLike } from '@server/shared/types/foundry';
import type { RouteFoundryClient } from '@server/shared/types/requestContext';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { FoundryUserRole } from '@server/core/documents/primary/base/ownership';

// Base runtime is module-scoped (logger/dataStore/compendium/foundryUrl + read-only
// documents) — memoize per module so per-request work is just binding the user-bound
// services onto req.runtime (ADR-0027 decision 5).
const baseRuntimeCache = new Map<string, Promise<ModuleRuntime>>();
function getBaseRuntime(moduleId: string): Promise<ModuleRuntime> {
    let base = baseRuntimeCache.get(moduleId);
    if (!base) {
        base = createModuleRuntime(moduleId);
        baseRuntimeCache.set(moduleId, base);
    }
    return base;
}

function escapeRegexSegment(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createModuleUserSession(userSession: FoundryUserConnectionLike): UserSession {
    const userId = userSession.userId;
    if (!userId) throw new SdkError('permission_denied', 'No access context could be resolved for this request');
    const role = userStore.getRole(userId);
    return {
        userId,
        username: userSession.username ?? userId,
        role,
        isGM: role >= FoundryUserRole.GAMEMASTER,
    };
}

// Access data is derived at the module boundary rather than trusting caller-supplied
// role/GM flags; the User Store remains the authority for the active world.
function createAccessContext(moduleId: string, userSession: FoundryUserConnectionLike): ModuleAccessContext {
    const userId = userSession.userId;
    if (!userId) throw new SdkError('permission_denied', 'No access context could be resolved for this request');
    const role = userStore.getRole(userId);
    return {
        userId,
        role,
        isGM: role >= FoundryUserRole.GAMEMASTER,
        moduleId,
    };
}

export function compileModuleRoutePattern(pattern: string): RegExp {
    const tokenRegex = /\[.*?\]/g;
    let compiled = '^';
    let lastIndex = 0;

    for (const match of pattern.matchAll(tokenRegex)) {
        const matchIndex = match.index ?? 0;
        compiled += escapeRegexSegment(pattern.slice(lastIndex, matchIndex));
        compiled += '([^/]+)';
        lastIndex = matchIndex + match[0].length;
    }

    compiled += escapeRegexSegment(pattern.slice(lastIndex));
    compiled += '$';

    return new RegExp(compiled);
}

interface ModuleProxyServiceDeps {
    getServerModule?: (systemId: string) => Promise<ModuleServerLike | null> | ModuleServerLike | null;
    getBaseRuntime?: (moduleId: string) => Promise<ModuleRuntime>;
}

export function createModuleProxyService(deps: ModuleProxyServiceDeps = {}) {
    const resolveServerModule = deps.getServerModule ?? getRegisteredServerModule;
    const resolveBaseRuntime = deps.getBaseRuntime ?? getBaseRuntime;

    // Route matcher for module apiRoutes patterns such as [id] segments.
    const findMatchedPattern = (routes: string[], routePath: string): string | undefined => {
        for (const pattern of routes) {
            const regex = compileModuleRoutePattern(pattern);
            if (regex.test(routePath)) return pattern;
        }
        return undefined;
    };

    // Module proxy dispatch orchestration preserving existing Next-style handler contract.
    const dispatchModuleRoute = async (request: ModuleProxyDispatchRequest): Promise<ModuleProxyDispatchResult> => {
        const parts = request.path.split('/').filter(Boolean);
        const systemId = parts[0];
        const routePath = parts.slice(1).join('/');

        if (!systemId) return { status: 404, payload: { error: 'No system specified' } };

        if (!request.foundryClient) {
            return { status: 401, payload: { error: 'Unauthorized: Missing Foundry session' } };
        }

        if (!request.userSession?.userId) {
            logger.warn(`Module Routing | Rejected non-user module API request for ${systemId}/${routePath || '<root>'}.`);
            return { status: 403, payload: { error: 'Forbidden: Module API routes require a Foundry user session' } };
        }

        const rawClient = request.foundryClient;
        if (!rawClient.userId || rawClient.userId !== request.userSession.userId) {
            logger.warn(
                `Module Routing | Rejected module API request for ${systemId}/${routePath || '<root>'}: session user ${request.userSession.userId} does not match transport user ${rawClient.userId ?? '<missing>'}.`
            );
            return { status: 403, payload: { error: 'Forbidden: Foundry session does not match the request transport' } };
        }

        const sysModule = await resolveServerModule(systemId) as ModuleServerLike | null;
        if (!sysModule) {
            logger.warn(`Module Routing | Module ${systemId} not found or missing server entry point.`);
            return { status: 404, payload: { error: `Module ${systemId} not found` } };
        }

        if (!sysModule.apiRoutes) {
            logger.warn(`Module Routing | Module ${systemId} missing apiRoutes.`);
            return { status: 404, payload: { error: `Module ${systemId} API not available` } };
        }

        const routes = Object.keys(sysModule.apiRoutes);
        const matchedPattern = findMatchedPattern(routes, routePath);

        if (!matchedPattern) {
            logger.warn(`Module Routing | No handler found for ${systemId}/${routePath}. Available routes: ${routes.join(', ')}`);
            logger.error(`[DEBUG] sysModule.apiRoutes keys for ${systemId}:`, Object.keys(sysModule.apiRoutes));
            return { status: 404, payload: { error: `Route ${routePath} not found` } };
        }

        const handler = sysModule.apiRoutes[matchedPattern];

        // Per-request runtime handle (ADR-0027): base (memoized per module) + the caller's
        // user-bound document/roll/table services. Document ops default to the caller.
        const baseRuntime = await resolveBaseRuntime(systemId);
        const runtime = createModuleRequestRuntime(baseRuntime, rawClient);
        const userSession = createModuleUserSession(request.userSession);

        const nextRequest = {
            json: async () => request.body,
            method: request.method,
            url: request.url,
            headers: request.headers,
            runtime,
            userSession,
            getAccessContext: () => createAccessContext(systemId, request.userSession!),
        };
        const nextParams = { params: Promise.resolve({ systemId, route: routePath.split('/') }) };

        logger.info(`Module Router | Calling handler for ${matchedPattern} with actorId: ${routePath.split('/')[1]}`);
        const result = await handler(nextRequest as any, nextParams) as NextLikeResponse | unknown;

        if (typeof result === 'object' && result !== null && 'json' in result && typeof (result as NextLikeResponse).json === 'function') {
            const response = result as NextLikeResponse;
            const data = await response.json!();
            return { status: response.status || 200, payload: data };
        }

        return { status: 200, payload: result };
    };

    return {
        dispatchModuleRoute
    };
}
