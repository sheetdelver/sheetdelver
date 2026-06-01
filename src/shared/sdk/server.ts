import type { ModuleFoundryClient } from './contracts';
import type { UserSession } from './contracts';
import type { ModuleRuntime } from './runtime';
import { SDK_ERROR_STATUS, type SdkErrorCode } from './errors';

/**
 * Explicit per-operation authorization context derived from the request
 * (ADR-0027 decision 9). Passed into document operations as `{ access }`; the
 * platform resolves effective ownership against it and fails closed.
 */
export interface ModuleAccessContext {
    userId: string;
    role: number;
    isGM: boolean;
    moduleId: string;
    /** Module trust/permission grants resolved by the platform (decision 10). */
    trustTier?: 'first-party' | 'verified-third-party' | 'unverified';
    permissions?: {
        network?: boolean;
        adminRoutes?: boolean;
        sensitiveData?: string[];
    };
}

/**
 * The request object passed to module apiRoute handlers by the platform.
 * Thin: identity + body only. Document/roll/table/compendium access is on the
 * `ModuleRuntime` passed to `createApiRoutes(runtime)` — not on the request.
 */
export interface ModuleServerRequest {
    json<T = unknown>(): Promise<T>;
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    userSession?: UserSession;
    /**
     * Per-call authorization context derived from the request (ADR-0027 decision 9).
     * Optional during the transition; becomes required and `foundryClient` is removed
     * when the dispatch rewrite lands.
     */
    getAccessContext?(): ModuleAccessContext;
    /** @deprecated Transitional. Removed with the dispatch rewrite; use ModuleRuntime services. */
    foundryClient: ModuleFoundryClient;
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
 * Return either this shape (e.g. via `json()` / `error()`) or any value — the platform serializes it.
 */
export interface ModuleServerResponse {
    status?: number;
    json(): Promise<unknown>;
}

/**
 * Handler signature for entries in a module's route table.
 */
export type ModuleRouteHandler = (
    request: ModuleServerRequest,
    params: ModuleServerParams
) => Promise<ModuleServerResponse | unknown>;

/** A module route table: path pattern → handler. */
export type ModuleRouteTable = Record<string, ModuleRouteHandler>;

/**
 * The shape a module's server.ts must satisfy.
 * Prefer `createApiRoutes(runtime)` (route handlers compose over the mounted runtime);
 * `apiRoutes` is for runtime-free route tables only.
 */
export interface ModuleServerExport {
    createApiRoutes?: (runtime: ModuleRuntime) => ModuleRouteTable | Promise<ModuleRouteTable>;
    apiRoutes?: ModuleRouteTable;
}

// ---------------------------------------------------------------------------
// Response helpers (ADR-0027 decision 24) — modules return these, never a raw Response.
// ---------------------------------------------------------------------------

/** Build a success response with optional status (default 200). */
export function json(data: unknown, init?: { status?: number }): ModuleServerResponse {
    const status = init?.status ?? 200;
    return { status, json: async () => data };
}

/** Build a structured error response carrying the SdkError code + status. */
export function error(code: SdkErrorCode, message: string, status?: number): ModuleServerResponse {
    const resolved = status ?? SDK_ERROR_STATUS[code];
    return { status: resolved, json: async () => ({ error: message, code, status: resolved }) };
}
