'use client';

/**
 * WorldManagementPanel
 *
 * World management controls — lists available Foundry worlds, allows launching,
 * shutting down, and connection retry.
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
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import ErrorState from './ui/ErrorState';

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
            // Poll world state until it settles into the expected target rather than
            // guessing a single fixed delay (ADR-0030 UX-5). Bounded to avoid hanging.
            const settled = action === 'shutdown'
                ? (s: string) => s === 'closed'
                : (s: string) => s !== 'closed' && s !== 'unknown';
            for (let i = 0; i < 12; i++) {
                await new Promise(r => setTimeout(r, 1500));
                const statusResult = await fetchAdminStatus();
                const nextState = statusResult.ok && statusResult.data
                    ? (statusResult.data.worldState || 'unknown')
                    : 'unknown';
                setWorldState(nextState);
                if (settled(nextState)) break;
            }
            await loadData();
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
            <div className="mb-4 flex items-center justify-end">
                <div className="flex items-center gap-2">
                    {/* Shutdown button (only when a world is active) */}
                    {isConnected && (
                        <Button variant="danger" size="sm" onClick={() => handleWorldAction('shutdown')} disabled={!!operationInProgress}>
                            {operationInProgress === 'shutdown' ? 'Shutting down...' : 'Shutdown World'}
                        </Button>
                    )}

                    {/* Retry button (only when disconnected) */}
                    {!isConnected && (
                        <Button variant="primary" size="sm" onClick={() => handleWorldAction('retry')} disabled={!!operationInProgress}>
                            {operationInProgress === 'retry' ? 'Reconnecting...' : 'Re-Connect'}
                        </Button>
                    )}

                    {/* Refresh */}
                    <Button variant="secondary" size="sm" onClick={loadData} disabled={loading}>
                        Refresh
                    </Button>
                </div>
            </div>

            {/* Error */}
            {error && <ErrorState message={error} className="mb-4" />}

            {/* World list */}
            <div className="space-y-2">
                {worlds.length === 0 ? (
                    <EmptyState message="No worlds available. Connect to Foundry to discover worlds." />
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
                                className="rounded-md bg-[var(--admin-success)] px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-[var(--admin-success-strong)] disabled:opacity-50"
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
