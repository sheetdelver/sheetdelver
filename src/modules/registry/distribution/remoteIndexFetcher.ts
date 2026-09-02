import { validateModuleIndexDocument, type ModuleIndexDocument } from './moduleIndex';
import { logger } from '@shared/utils/logger';

export interface RemoteIndexFetchOptions {
    auth?: { type: 'bearer'; token: string };
    timeoutMs?: number;
    retries?: number;
    backoffMs?: number;
}

export type RemoteIndexErrorCode =
    | 'network-error'
    | 'auth-failed'
    | 'timeout'
    | 'malformed-index'
    | 'schema-mismatch'
    | 'http-error';

export interface RemoteIndexFetchResult {
    ok: boolean;
    index?: ModuleIndexDocument;
    error?: string;
    errorCode?: RemoteIndexErrorCode;
}

interface CacheEntry {
    index: ModuleIndexDocument;
    timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function fetchRemoteIndex(url: string, options: RemoteIndexFetchOptions = {}): Promise<RemoteIndexFetchResult> {
    const {
        auth,
        timeoutMs = 10000,
        retries = 3,
        backoffMs = 1000
    } = options;

    const now = Date.now();
    const cached = cache.get(url);
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
        return { ok: true, index: cached.index };
    }

    let attempt = 0;

    while (attempt <= retries) {
        attempt++;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            const headers: Record<string, string> = {
                'Accept': 'application/json'
            };

            if (auth?.type === 'bearer' && auth.token) {
                headers['Authorization'] = `Bearer ${auth.token}`;
            }

            const response = await fetch(url, {
                headers,
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    return { ok: false, errorCode: 'auth-failed', error: `Authentication failed (HTTP ${response.status})` };
                }
                if (attempt > retries) {
                    return { ok: false, errorCode: 'http-error', error: `HTTP Error: ${response.status} ${response.statusText}` };
                }
            } else {
                const text = await response.text();
                let data: unknown;
                try {
                    data = JSON.parse(text);
                } catch (e) {
                    return { ok: false, errorCode: 'malformed-index', error: 'Invalid JSON payload' };
                }

                const validation = validateModuleIndexDocument(data as any);
                if (!validation.valid) {
                    return { ok: false, errorCode: 'schema-mismatch', error: `Schema validation failed: ${validation.errors.join('; ')}` };
                }

                const indexDoc = data as ModuleIndexDocument;
                cache.set(url, { index: indexDoc, timestamp: Date.now() });

                return { ok: true, index: indexDoc };
            }

        } catch (error: unknown) {
            if (error instanceof Error && error.name === 'AbortError') {
                if (attempt > retries) {
                    return { ok: false, errorCode: 'timeout', error: 'Request timed out' };
                }
            } else if (attempt > retries) {
                return { ok: false, errorCode: 'network-error', error: error instanceof Error ? error.message : 'Network error' };
            }
        }

        // Wait before retry if we are going to try again
        if (attempt <= retries) {
            await new Promise(res => setTimeout(res, backoffMs * attempt));
        }
    }

    return { ok: false, errorCode: 'network-error', error: 'Max retries exceeded' };
}
