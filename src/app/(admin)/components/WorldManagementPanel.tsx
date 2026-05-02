'use client';

/**
 * WorldManagementPanel
 *
 * World management controls — lists available Foundry worlds, allows launching,
 * shutting down, connection retry, and manual deep-scrape operations.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { logger } from '@shared/utils/logger';
import { useAdminAuth } from '../context/AdminAuthContext';
import {
    fetchWorlds,
    fetchAdminStatus,
    postWorldAction,
    type WorldEntry,
} from '../lib/adminApi';

export default function WorldManagementPanel() {
    const { logout } = useAdminAuth();
    const [worlds, setWorlds] = useState<WorldEntry[]>([]);
    const [worldState, setWorldState] = useState<string>('unknown');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [operationInProgress, setOperationInProgress] = useState<string | null>(null);

    /** Load world list and current state. */
    const loadData = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);

            // Fetch worlds and status in parallel
            const [worldsResult, statusResult] = await Promise.all([
                fetchWorlds(),
                fetchAdminStatus(),
            ]);

            if (worldsResult.sessionExpired || statusResult.sessionExpired) {
                logout();
                return;
            }

            if (worldsResult.ok && worldsResult.data) {
                // Handle both array and object responses
                const worldList = Array.isArray(worldsResult.data)
                    ? worldsResult.data
                    : [];
                setWorlds(worldList);
            }

            if (statusResult.ok && statusResult.data) {
                setWorldState(statusResult.data.worldState || 'unknown');
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            logger.error('Failed to load world data:', err);
            setError(message);
        } finally {
            setLoading(false);
        }
    }, [logout]);

    // Initial load
    useEffect(() => {
        loadData();
    }, [loadData]);

    /** Execute a world action (launch, shutdown, retry). */
    const handleWorldAction = async (
        action: 'launch' | 'shutdown' | 'retry',
        body?: Record<string, unknown>
    ) => {
        try {
            setOperationInProgress(action);
            setError(null);

            const result = await postWorldAction(action, body);

            if (result.sessionExpired) {
                logout();
                return;
            }

            if (!result.ok) {
                throw new Error(result.error || `Failed to ${action}`);
            }

            logger.info(`World ${action} completed:`, result.data?.message);
            // Refresh data after a short delay (world needs time to transition)
            setTimeout(loadData, 2000);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            logger.error(`World ${action} failed:`, err);
            setError(message);
        } finally {
            setOperationInProgress(null);
        }
    };

    // ─── Loading ───────────────────────────────────────────────────

    if (loading && worlds.length === 0) {
        return (
            <div className="p-4">
                <h2 className="mb-4 text-2xl font-bold tracking-tight text-[var(--admin-text-primary)]">World Management</h2>
                <div className="space-y-3">
                    {[1, 2].map(i => (
                        <div key={i} className="h-16 animate-pulse rounded-xl bg-[var(--admin-surface)]" />
                    ))}
                </div>
            </div>
        );
    }

    // ─── Render ────────────────────────────────────────────────────

    const isConnected = worldState !== 'closed' && worldState !== 'unknown';

    return (
        <div className="p-4">
            <div className="mb-4 flex items-center justify-between">
                <h2 className="text-2xl font-bold tracking-tight text-[var(--admin-text-primary)]">World Management</h2>
                <div className="flex items-center gap-2">
                    {/* Shutdown button (only when a world is active) */}
                    {isConnected && (
                        <button
                            onClick={() => handleWorldAction('shutdown')}
                            disabled={!!operationInProgress}
                            className="rounded-xl bg-[var(--admin-danger-button)] px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-[var(--admin-danger-button-strong)] disabled:opacity-50"
                        >
                            {operationInProgress === 'shutdown' ? 'Shutting down...' : 'Shutdown World'}
                        </button>
                    )}

                    {/* Retry button (only when disconnected) */}
                    {!isConnected && (
                        <button
                            onClick={() => handleWorldAction('retry')}
                            disabled={!!operationInProgress}
                            className="rounded-xl bg-[var(--admin-accent)] px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-[var(--admin-accent-strong)] disabled:opacity-50"
                        >
                            {operationInProgress === 'retry' ? 'Reconnecting...' : 'Re-Connect'}
                        </button>
                    )}

                    {/* Refresh */}
                    <button
                        onClick={loadData}
                        disabled={loading}
                        className="rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-1.5 text-sm text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)] disabled:opacity-50"
                    >
                        Refresh
                    </button>
                </div>
            </div>

            {/* Error */}
            {error && (
                <div className="mb-4 rounded-xl border border-[var(--admin-danger-border)] bg-[var(--admin-danger-bg)] p-3 text-sm text-[var(--admin-danger-text)]">
                    {error}
                </div>
            )}

            {/* World list */}
            <div className="space-y-2">
                {worlds.length === 0 ? (
                    <p className="text-[var(--admin-text-muted)]">No worlds available. Connect to Foundry to discover worlds.</p>
                ) : (
                    worlds.map((world, index) => (
                        <div
                            key={`${world.id}-${index}`}
                            className="flex items-center justify-between rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] p-3 transition hover:bg-[var(--admin-surface-hover)]"
                        >
                            <div>
                                <h4 className="font-semibold text-[var(--admin-text-primary)]">{world.title}</h4>
                                <p className="text-xs text-[var(--admin-text-muted)] font-mono">{world.id}</p>
                                {world.system && (
                                    <p className="text-xs text-[var(--admin-text-secondary)]">System: {world.system}</p>
                                )}
                            </div>
                            <button
                                onClick={() => handleWorldAction('launch', { worldId: world.id })}
                                disabled={!!operationInProgress || isConnected}
                                className="rounded-xl bg-[var(--admin-success)] px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-[var(--admin-success-strong)] disabled:opacity-50"
                            >
                                {operationInProgress === 'launch' ? 'Launching...' : 'Launch'}
                            </button>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
