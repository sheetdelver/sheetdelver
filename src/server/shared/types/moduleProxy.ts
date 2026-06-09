import type { IncomingHttpHeaders } from 'node:http';
import type { FoundryUserConnectionLike } from '@server/shared/types/foundry';
import type { RouteFoundryClient } from '@server/shared/types/requestContext';
import type { UserSession } from '@shared/sdk/contracts';
import type { ModuleAccessContext, ModuleRequestRuntime } from '@shared/sdk/runtime';

export interface ModuleProxyDispatchRequest {
    path: string;
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: unknown;
    /** User-bound route transport used only to bind req.runtime; never exposed to module handlers. */
    transportClient?: RouteFoundryClient;
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
    runtime: ModuleRequestRuntime;
    userSession?: UserSession;
    getAccessContext(): ModuleAccessContext;
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
