import type { ModuleFoundryClient } from './contracts';
import type { UserSession } from './contracts';

/**
 * The request object passed to module apiRoute handlers by the platform.
 * foundryClient and userSession are injected by the platform before dispatch —
 * modules do not construct this object themselves.
 */
export interface ModuleServerRequest {
    json<T = unknown>(): Promise<T>;
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    foundryClient: ModuleFoundryClient;
    userSession?: UserSession;
}

/**
 * The params object passed to module apiRoute handlers.
 * systemId is the module's id. route contains the path segments after the system prefix.
 */
export interface ModuleServerParams {
    params: Promise<{ systemId: string; route: string[] }>;
}

/**
 * The return type for module apiRoute handlers.
 * Return either this shape or any value — the platform will serialize it.
 */
export interface ModuleServerResponse {
    status?: number;
    json(): Promise<unknown>;
}

/**
 * Handler signature for entries in a module's apiRoutes export.
 */
export type ModuleRouteHandler = (
    request: ModuleServerRequest,
    params: ModuleServerParams
) => Promise<ModuleServerResponse | unknown>;

/**
 * The shape a module's server.ts must satisfy.
 * Export apiRoutes as a named export or as default.
 */
export interface ModuleServerExport {
    apiRoutes?: Record<string, ModuleRouteHandler>;
}
