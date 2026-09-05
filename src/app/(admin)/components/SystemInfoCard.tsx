'use client';

/**
 * SystemInfoCard
 *
 * Displays system overview information from the admin API with auto-refresh.
 * Shows connection status, world info, and debug state using admin theme variables.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { fetchAdminStatus, type AdminStatusResponse } from '../lib/adminApi';
import { useAdminAuth } from '../context/AdminAuthContext';

/** Auto-refresh interval in milliseconds. */
const REFRESH_INTERVAL_MS = 10_000;

export default function SystemInfoCard() {
    const { logout } = useAdminAuth();
    const [system, setSystem] = useState<AdminStatusResponse | null>(null);
    const [loading, setLoading] = useState(true);

    /** Fetch admin status from the API. */
    const loadStatus = useCallback(async () => {
        const result = await fetchAdminStatus();

        if (result.sessionExpired) {
            logout();
            return;
        }

        if (result.ok && result.data) {
            setSystem(result.data);
        }
        setLoading(false);
    }, [logout]);

    // Initial fetch + auto-refresh
    useEffect(() => {
        loadStatus();
        const interval = setInterval(loadStatus, REFRESH_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [loadStatus]);

    // ─── Loading skeleton ──────────────────────────────────────────

    if (loading && !system) {
        return (
            <div className="space-y-3">
                <h2 className="text-2xl font-bold tracking-tight text-[var(--admin-text-primary)]">System Overview</h2>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    {[1, 2, 3].map(i => (
                        <div key={i} className="h-20 animate-pulse rounded-xl bg-[var(--admin-surface)]" />
                    ))}
                </div>
            </div>
        );
    }

    // ─── Data extraction ───────────────────────────────────────────

    const connected = system?.connected || false;
    const worldSystem = system?.system?.id || 'Unknown';
    const worldVersion = system?.system?.version || 'Unknown';
    const worldName = system?.system?.worldTitle || 'Unknown';
    const worldStatus = system?.system?.status || 'Unknown';
    const worldState = system?.worldState || 'unknown';

    // ─── Render ────────────────────────────────────────────────────

    return (
        <div className="space-y-4">
            <h2 className="text-2xl font-bold tracking-tight text-[var(--admin-text-primary)]">System Overview</h2>

            {/* System banner */}
            <div className={`rounded-xl p-4 text-center ${connected
                ? 'bg-[var(--admin-success-bg)] border border-[var(--admin-success-border)]'
                : 'bg-[var(--admin-danger-bg)] border border-[var(--admin-danger-border)]'
            }`}>
                <h3 className="text-lg font-bold text-[var(--admin-text-primary)] uppercase">
                    {worldSystem} ({worldVersion})
                </h3>
                <p className="text-sm text-[var(--admin-text-secondary)]">{worldName}</p>
            </div>

            {/* Info cards grid */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <InfoCard title="Status" value={worldStatus} />
                <InfoCard title="World State" value={worldState} />
                <InfoCard
                    title="Connection"
                    value={connected ? 'Connected' : 'Disconnected'}
                    variant={connected ? 'success' : 'danger'}
                />
                <InfoCard title="Initialized" value={system?.initialized ? 'Yes' : 'No'} />
                <InfoCard title="Configured" value={system?.isConfigured ? 'Yes' : 'No'} />
                <InfoCard title="Debug" value={system?.debug?.enabled ? `Level ${system.debug.level}` : 'Off'} />
            </div>

            {/* Connection URL */}
            {system?.url && (
                <div className={`rounded-xl px-4 py-3 text-sm ${
                    connected
                        ? 'bg-[var(--admin-success-bg)] text-[var(--admin-success)] border border-[var(--admin-success-border)]'
                        : 'bg-[var(--admin-danger-bg)] text-[var(--admin-danger-text)] border border-[var(--admin-danger-border)]'
                }`}>
                    <span className="font-semibold">{connected ? '✓ Connected' : '✗ Disconnected'}:</span>
                    <span className="ml-2 font-mono">{system.url}</span>
                </div>
            )}

            {/* User counts */}
            {system?.system?.users && (
                <div className="grid grid-cols-2 gap-3">
                    <InfoCard title="Total Users" value={system.system.users.total?.toString() ?? '—'} />
                    <InfoCard title="Active Users" value={system.system.users.active?.toString() ?? '—'} />
                </div>
            )}
        </div>
    );
}

// ─── Sub-components ────────────────────────────────────────────────

/** Individual info card with title and value. */
function InfoCard({
    title,
    value,
    variant,
}: {
    title: string;
    value: string;
    variant?: 'success' | 'danger';
}) {
    const bgClass = variant === 'success'
        ? 'bg-[var(--admin-success-bg)] border-[var(--admin-success-border)]'
        : variant === 'danger'
            ? 'bg-[var(--admin-danger-bg)] border-[var(--admin-danger-border)]'
            : 'bg-[var(--admin-surface)] border-[var(--admin-border)]';

    return (
        <div className={`rounded-xl border p-3 text-center ${bgClass}`}>
            <p className="text-xs font-bold uppercase tracking-wider text-[var(--admin-text-muted)]">{title}</p>
            <p className="mt-1 text-lg font-semibold text-[var(--admin-text-primary)]">{value}</p>
        </div>
    );
}