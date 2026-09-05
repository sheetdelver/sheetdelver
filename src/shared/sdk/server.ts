import type { UserSession } from './contracts';
import type { ModuleAccessContext, ModuleRequestRuntime } from './runtime';
import { SDK_ERROR_STATUS, type SdkErrorCode } from './errors';

// ModuleAccessContext is defined in ./runtime (it's a runtime concept) and re-exported here.
export type { ModuleAccessContext } from './runtime';

/**
 * The request object passed to module apiRoute handlers by the platform.
 * Identity + body + the per-request runtime handle (ADR-0027 decision 8). Document /
 * roll / table services live on `req.runtime`, defaulting to the calling user. The broad
 * `foundryClient` was removed — `req.runtime` is the only document surface.
 */
export interface ModuleServerRequest {
    json<T = unknown>(): Promise<T>;
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    userSession?: UserSession;
    /** Per-request runtime handle; document ops default to the caller (`userSession`). */
    runtime: ModuleRequestRuntime;
    /** Read the caller's access context (or build a `{ access }` override). */
    getAccessContext(): ModuleAccessContext;
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
 * The shape a module's server.ts must satisfy: a static `apiRoutes` table.
 * The per-request runtime is delivered on `req.runtime` (ADR-0027 decision 8) — there is
 * no `createApiRoutes(runtime)` factory.
 */
export interface ModuleServerExport {
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
