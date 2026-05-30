import type { IncomingHttpHeaders } from 'node:http';
import type { FoundryUserConnectionLike } from '@server/shared/types/foundry';
import type { RouteFoundryClient } from '@server/shared/types/requestContext';

export interface ModuleProxyDispatchRequest {
    path: string;
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: unknown;
    foundryClient?: RouteFoundryClient;
    userSession?: FoundryUserConnectionLike;
}

export interface ModuleRouteParams {
    params: Promise<{ systemId: string; route: string[] }>;
}

export interface ModuleRouteRequest {
    json: () => Promise<unknown>;
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    foundryClient: RouteFoundryClient;
    userSession?: FoundryUserConnectionLike;
}

export interface ModuleProxyDispatchResult {
    status: number;
    payload: unknown;
}

export interface NextLikeResponse {
    status?: number;
    json?: () => Promise<unknown>;
}

export interface ModuleRouteHandler {
    (
        req: ModuleRouteRequest,
        params: ModuleRouteParams
    ): Promise<NextLikeResponse | unknown>;
}

export interface ModuleServerLike {
    apiRoutes?: Record<string, ModuleRouteHandler>;
}
