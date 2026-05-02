/**
 * Admin API Client
 *
 * Typed API client for the admin panel. Centralizes all admin API access,
 * handles authentication headers, CSRF tokens, and 401 session expiry.
 *
 * Usage:
 *   import { fetchModuleLifecycle, postWorldAction } from '../lib/adminApi';
 *   const result = await fetchModuleLifecycle();
 *   if (result.ok) { ... result.data ... }
 */

// ─── Types ─────────────────────────────────────────────────────────

/** Standard result wrapper for all admin API calls. */
export interface AdminApiResult<T> {
    ok: boolean;
    status: number;
    data: T | null;
    error: string | null;
    /** True if the session has expired (401). Components should redirect to login. */
    sessionExpired: boolean;
}

/** Module lifecycle info returned by GET /admin/lifecycle */
export interface ModuleLifecycleInfo {
    moduleId: string;
    title: string;
    enabled: boolean;
    status: string;
    experimental: boolean;
    reason?: string;
    health?: {
        errorCount: number;
        lastError?: string;
        lastErrorAt?: number;
    };
    validation?: {
        manifestValid: boolean;
        diagnostics: Array<{ code: string; message: string; severity: string }>;
    };
    artifact?: {
        version: string;
        source: string;
        installedAt: number;
        integrity?: string;
        signature?: string;
    };
}

/** Module lifecycle list response */
export interface ModuleLifecycleResponse {
    success: boolean;
    modules: ModuleLifecycleInfo[];
}

/** Admin status response (superset of public status) */
export interface AdminStatusResponse {
    connected: boolean;
    initialized: boolean;
    isConfigured: boolean;
    url?: string;
    debug?: { enabled: boolean; level: number };
    system?: {
        id: string;
        version: string;
        worldTitle: string;
        status: string;
        users?: { total: number; active: number };
    };
    users?: Array<{ name: string; _id: string }>;
    socket?: boolean;
    worldState?: string;
    userId?: string;
    isExplicit?: boolean;
    discoveredUserId?: string;
}

/** World entry from GET /admin/worlds */
export interface WorldEntry {
    id: string;
    title: string;
    description?: string;
    system?: string;
    active?: boolean;
}

/** Cache state from GET /admin/cache */
export interface CacheStateResponse {
    currentWorldId?: string;
    worlds: Record<string, WorldEntry>;
    [key: string]: unknown;
}

/** Audit event from GET /admin/audit */
export interface AdminAuditEvent {
    eventId: string;
    timestamp: number;
    adminId: string;
    action: string;
    method: string;
    path: string;
    ip: string;
    statusCode?: number;
    details?: Record<string, unknown>;
}

/** Audit log response */
export interface AuditLogResponse {
    success: boolean;
    count: number;
    events: AdminAuditEvent[];
}

/** Manager operation result */
export interface ManagerOperationResult {
    success: boolean;
    moduleId: string;
    operation: string;
    previousStatus?: string;
    newStatus?: string;
    error?: string;
    errorCode?: string;
    violations?: Array<{ code: string; message: string }>;
}

/** Dry-run preview result */
export interface DryRunPreviewResult {
    allowed: boolean;
    moduleId: string;
    operation: string;
    trustPolicy?: {
        tier: string;
        allowed: boolean;
        reason?: string;
    };
    permissions?: {
        current: Record<string, unknown>;
        requested: Record<string, unknown>;
        escalationRequired: boolean;
    };
    compatibility?: {
        compatible: boolean;
        diagnostics: Array<{ code: string; message: string; severity: string }>;
    };
    dependencies?: {
        satisfied: boolean;
        missing: string[];
        conflicts: string[];
    };
    [key: string]: unknown;
}

/** World action result */
export interface WorldActionResult {
    success: boolean;
    message?: string;
    error?: string;
}

// ─── Source Profiles ───────────────────────────────────────────────

export interface SourceProfile {
    id: string;
    name: string;
    kind: 'local' | 'indexed' | 'direct';
    baseUrl: string;
    enabled: boolean;
    priority: number;
    auth?: { type: 'bearer'; token: string };
    hostAllowlist?: string[];
    createdAt: number;
    updatedAt: number;
}

export interface SourceProfileResponse {
    success: boolean;
    profiles?: SourceProfile[];
    profile?: SourceProfile;
}

export interface SourceProfileTestResponse {
    success: boolean;
    message?: string;
    schemaVersion?: number;
    publisher?: string;
    moduleCount?: number;
    error?: string;
    errorCode?: string;
}

// ─── Path Helper ───────────────────────────────────────────────────

/** Constructs the full admin API path from a relative path. */
export function adminApiPath(path: string): string {
    return `/api/admin${path.startsWith('/') ? path : `/${path}`}`;
}

// ─── Core Fetch Wrapper ────────────────────────────────────────────

/**
 * Typed fetch wrapper for admin API calls.
 * Automatically attaches auth token and CSRF headers from localStorage.
 * Handles 401 (session expired) responses.
 *
 * @param path - Relative admin API path (e.g., '/lifecycle')
 * @param options - Optional fetch options (method, body, etc.)
 * @returns Typed result with ok/data/error/sessionExpired
 */
export async function adminFetch<T>(
    path: string,
    options: RequestInit = {}
): Promise<AdminApiResult<T>> {
    const token = localStorage.getItem('admin-token');
    const csrf = localStorage.getItem('admin-csrf');

    // Build headers with auth credentials
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string> || {}),
    };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    if (csrf) {
        headers['X-Admin-CSRF-Token'] = csrf;
    }

    try {
        const response = await fetch(adminApiPath(path), {
            ...options,
            headers,
        });

        // Handle session expiry
        if (response.status === 401) {
            return {
                ok: false,
                status: 401,
                data: null,
                error: 'Session expired. Please log in again.',
                sessionExpired: true,
            };
        }

        // Parse response body
        const data = await response.json().catch(() => null);

        if (!response.ok) {
            return {
                ok: false,
                status: response.status,
                data: null,
                error: data?.error || `Request failed with status ${response.status}`,
                sessionExpired: false,
            };
        }

        return {
            ok: true,
            status: response.status,
            data: data as T,
            error: null,
            sessionExpired: false,
        };
    } catch (err) {
        return {
            ok: false,
            status: 0,
            data: null,
            error: err instanceof Error ? err.message : 'Network error',
            sessionExpired: false,
        };
    }
}

// ─── API Functions ─────────────────────────────────────────────────

/** Fetch admin system status (enriched with socket/world state). */
export function fetchAdminStatus() {
    return adminFetch<AdminStatusResponse>('/status');
}

/** Fetch module lifecycle list with full details. */
export function fetchModuleLifecycle() {
    return adminFetch<ModuleLifecycleResponse>('/lifecycle');
}

/** Fetch available Foundry worlds. */
export function fetchWorlds() {
    return adminFetch<WorldEntry[]>('/worlds');
}

/** Fetch current cache state. */
export function fetchCacheState() {
    return adminFetch<CacheStateResponse>('/cache');
}

/** Fetch admin audit log events (newest first). */
export function fetchAuditLog(limit: number = 100) {
    return adminFetch<AuditLogResponse>(`/audit?limit=${limit}`);
}

/**
 * Execute a module lifecycle action (enable/disable).
 *
 * @param moduleId - Target module ID
 * @param action - 'enable' or 'disable'
 * @param body - Optional request body (e.g., { reason: '...' })
 */
export function postLifecycleAction(
    moduleId: string,
    action: 'enable' | 'disable',
    body?: Record<string, unknown>
) {
    return adminFetch<ManagerOperationResult>(`/lifecycle/${moduleId}/${action}`, {
        method: 'POST',
        body: JSON.stringify(body || {}),
    });
}

/**
 * Execute a manager operation (install/uninstall/upgrade/validate).
 *
 * @param moduleId - Target module ID
 * @param action - Manager operation to perform
 * @param body - Optional request body (source, version, permissions, etc.)
 */
export function postManagerAction(
    moduleId: string,
    action: 'install' | 'uninstall' | 'upgrade' | 'validate',
    body?: Record<string, unknown>
) {
    return adminFetch<ManagerOperationResult>(`/manager/${moduleId}/${action}`, {
        method: 'POST',
        body: JSON.stringify(body || {}),
    });
}

/**
 * Execute a dry-run preview for install or upgrade.
 *
 * @param moduleId - Target module ID
 * @param action - 'install' or 'upgrade'
 * @param body - Request body with source, version, permissions, etc.
 */
export function postDryRun(
    moduleId: string,
    action: 'install' | 'upgrade',
    body?: Record<string, unknown>
) {
    return adminFetch<DryRunPreviewResult>(`/manager/${moduleId}/dry-run/${action}`, {
        method: 'POST',
        body: JSON.stringify(body || {}),
    });
}

/**
 * Execute a world management action.
 *
 * @param action - 'launch', 'shutdown', 'retry', or 'scrape'
 * @param body - Optional request body (e.g., { worldId: '...' } for launch)
 */
export function postWorldAction(
    action: 'launch' | 'shutdown' | 'retry' | 'scrape',
    body?: Record<string, unknown>
) {
    // Map action to the correct endpoint path
    const pathMap: Record<string, string> = {
        launch: '/world/launch',
        shutdown: '/world/shutdown',
        retry: '/world/retry',
        scrape: '/setup/scrape',
    };

    return adminFetch<WorldActionResult>(pathMap[action], {
        method: 'POST',
        body: JSON.stringify(body || {}),
    });
}

export function fetchSourceProfiles() {
    return adminFetch<SourceProfileResponse>('/sources');
}

export function createSourceProfile(profile: Partial<SourceProfile>) {
    return adminFetch<SourceProfileResponse>('/sources', {
        method: 'POST',
        body: JSON.stringify(profile),
    });
}

export function updateSourceProfile(id: string, updates: Partial<SourceProfile>) {
    return adminFetch<SourceProfileResponse>(`/sources/${id}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
    });
}

export function deleteSourceProfile(id: string) {
    return adminFetch<{ success: boolean; error?: string }>(`/sources/${id}`, {
        method: 'DELETE',
    });
}

export function testSourceProfile(id: string) {
    return adminFetch<SourceProfileTestResponse>(`/sources/${id}/test`, {
        method: 'POST',
    });
}