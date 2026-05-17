import { getServerModule } from '@modules/registry/server';
import { logger } from '@shared/utils/logger';
import { createModuleFoundryClient } from '@server/shared/utils/createModuleFoundryClient';
import type {
    ModuleProxyDispatchRequest,
    ModuleProxyDispatchResult,
    ModuleServerLike,
    NextLikeResponse,
} from '@server/shared/types/moduleProxy';

function escapeRegexSegment(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

export function createModuleProxyService() {
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

        const sysModule = await getServerModule(systemId) as ModuleServerLike | null;
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

        if (!request.foundryClient) {
            return { status: 401, payload: { error: 'Unauthorized: Missing Foundry session' } };
        }

        const handler = sysModule.apiRoutes[matchedPattern];
        const rawClient = request.foundryClient;
        const nextRequest = {
            json: async () => request.body,
            method: request.method,
            url: request.url,
            headers: request.headers,
            foundryClient: createModuleFoundryClient(rawClient),
            userSession: request.userSession
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
