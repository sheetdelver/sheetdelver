'use client';

/**
 * CacheInfoPanel
 *
 * Read-only view of the persistent cache state — current world ID,
 * cached world entries, and metadata.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { logger } from '@shared/utils/logger';
import { useAdminAuth } from '../context/AdminAuthContext';
import { fetchCacheState, type CacheStateResponse } from '../lib/adminApi';

export default function CacheInfoPanel() {
    const { logout } = useAdminAuth();
    const [cache, setCache] = useState<CacheStateResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    /** Fetch cache state from the admin API. */
    const loadCache = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);

            const result = await fetchCacheState();

            if (result.sessionExpired) {
                logout();
                return;
            }

            if (!result.ok || !result.data) {
                throw new Error(result.error || 'Failed to fetch cache state');
            }

            setCache(result.data);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            logger.error('Failed to fetch cache state:', err);
            setError(message);
        } finally {
            setLoading(false);
        }
    }, [logout]);

    // Initial load
    useEffect(() => {
        loadCache();
    }, [loadCache]);

    // ─── Loading ───────────────────────────────────────────────────

    if (loading && !cache) {
        return (
            <div className="p-4">
                <h2 className="mb-4 text-2xl font-bold tracking-tight text-[var(--admin-text-primary)]">Cache Info</h2>
                <div className="h-24 animate-pulse rounded-xl bg-[var(--admin-surface)]" />
            </div>
        );
    }

    // ─── Render ────────────────────────────────────────────────────

    const worldEntries = cache?.worlds ? Object.entries(cache.worlds) : [];

    return (
        <div className="p-4">
            <div className="mb-4 flex items-center justify-between">
                <h2 className="text-2xl font-bold tracking-tight text-[var(--admin-text-primary)]">Cache Info</h2>
                <button
                    onClick={loadCache}
                    disabled={loading}
                    className="rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-1.5 text-sm text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)] disabled:opacity-50"
                >
                    Refresh
                </button>
            </div>

            {/* Error */}
            {error && (
                <div className="mb-4 rounded-xl border border-[var(--admin-danger-border)] bg-[var(--admin-danger-bg)] p-3 text-sm text-[var(--admin-danger-text)]">
                    {error}
                </div>
            )}

            {!cache ? (
                <p className="text-[var(--admin-text-muted)]">No cache data available.</p>
            ) : (
                <div className="space-y-3">
                    {/* Current world */}
                    <div className="rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] p-3">
                        <p className="text-xs font-bold uppercase tracking-wider text-[var(--admin-text-muted)]">Current World ID</p>
                        <p className="mt-1 font-mono text-sm text-[var(--admin-text-primary)]">
                            {cache.currentWorldId || '—'}
                        </p>
                    </div>

                    {/* Cached worlds */}
                    <div className="rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] p-3">
                        <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--admin-text-muted)]">
                            Cached Worlds ({worldEntries.length})
                        </p>
                        {worldEntries.length === 0 ? (
                            <p className="text-sm text-[var(--admin-text-muted)]">No worlds cached.</p>
                        ) : (
                            <div className="space-y-2">
                                {worldEntries.map(([id, world]) => (
                                    <div
                                        key={id}
                                        className={`rounded-lg border px-3 py-2 text-sm ${
                                            id === cache.currentWorldId
                                                ? 'border-[var(--admin-success-border)] bg-[var(--admin-success-bg)]'
                                                : 'border-[var(--admin-border)]'
                                        }`}
                                    >
                                        <span className="font-semibold text-[var(--admin-text-primary)]">
                                            {typeof world === 'object' && world !== null && 'title' in world
                                                ? (world as { title: string }).title
                                                : id}
                                        </span>
                                        <span className="ml-2 text-xs font-mono text-[var(--admin-text-muted)]">{id}</span>
                                        {id === cache.currentWorldId && (
                                            <span className="ml-2 rounded-full bg-[var(--admin-success)] px-2 py-0.5 text-xs text-white">Active</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
