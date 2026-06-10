'use client';

/**
 * AuditLogViewer
 *
 * Paginated audit event log viewer. Displays admin action history in a table
 * with timestamp, action, admin ID, and details. Supports "Load more" pagination
 * and optional action-type filtering.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { logger } from '@shared/utils/logger';
import { useAdminAuth } from '../context/AdminAuthContext';
import { fetchAuditLog, type AdminAuditEvent } from '../lib/adminApi';

/** Default number of events to fetch per page. */
const PAGE_SIZE = 25;

/** Formats an ISO-8601 timestamp to a locale-friendly date/time string. */
function formatTimestamp(ts: string): string {
    return new Date(ts).toLocaleString();
}

/** Extracts a human-readable action label from the request path. */
function formatAction(event: AdminAuditEvent): string {
    // Strip the /api/admin prefix and normalize
    const cleanPath = event.path
        .replace(/^\/api\/admin\/?/, '')
        .replace(/^\//, '');

    return `${event.method} ${cleanPath || '/'}`;
}

export default function AuditLogViewer() {
    const { logout } = useAdminAuth();
    const [events, setEvents] = useState<AdminAuditEvent[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [limit, setLimit] = useState(PAGE_SIZE);
    const [hasMore, setHasMore] = useState(true);
    const [filterAction, setFilterAction] = useState<string>('all');
    const [autoRefresh, setAutoRefresh] = useState(false);

    /** Fetch audit events from the admin API. */
    const loadEvents = useCallback(async (fetchLimit: number, isLoadMore = false) => {
        try {
            if (isLoadMore) {
                setLoadingMore(true);
            } else {
                setLoading(true);
            }
            setError(null);

            const result = await fetchAuditLog(fetchLimit);

            if (result.sessionExpired) {
                logout();
                return;
            }

            if (!result.ok || !result.data) {
                throw new Error(result.error || 'Failed to fetch audit log');
            }

            const newEvents = result.data.events || [];
            setEvents(newEvents);
            setHasMore(newEvents.length >= fetchLimit);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            logger.error('Failed to fetch audit log:', err);
            setError(message);
        } finally {
            setLoading(false);
            setLoadingMore(false);
        }
    }, [logout]);

    // Initial load
    useEffect(() => {
        loadEvents(limit);
    }, [loadEvents, limit]);

    // Auto-refresh
    useEffect(() => {
        if (!autoRefresh) return;
        const interval = setInterval(() => loadEvents(limit), 10_000);
        return () => clearInterval(interval);
    }, [autoRefresh, loadEvents, limit]);

    /** Load more events by increasing the limit. */
    const handleLoadMore = () => {
        const newLimit = limit + PAGE_SIZE;
        setLimit(newLimit);
        loadEvents(newLimit, true);
    };

    // ─── Derive unique action types for filter ─────────────────────

    const actionTypes = Array.from(new Set(events.map(e => formatAction(e)))).sort();

    // ─── Filter events ─────────────────────────────────────────────

    const filteredEvents = filterAction === 'all'
        ? events
        : events.filter(e => formatAction(e) === filterAction);

    // ─── Loading ───────────────────────────────────────────────────

    if (loading && events.length === 0) {
        return (
            <div className="p-4">
                <h2 className="mb-4 text-2xl font-bold tracking-tight text-[var(--admin-text-primary)]">Audit Log</h2>
                <div className="space-y-2">
                    {[1, 2, 3, 4, 5].map(i => (
                        <div key={i} className="h-10 animate-pulse rounded-lg bg-[var(--admin-surface)]" />
                    ))}
                </div>
            </div>
        );
    }

    // ─── Render ────────────────────────────────────────────────────

    return (
        <div className="p-4">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="text-2xl font-bold tracking-tight text-[var(--admin-text-primary)]">Audit Log</h2>
                <div className="flex items-center gap-2">
                    {/* Action filter */}
                    <select
                        value={filterAction}
                        onChange={e => setFilterAction(e.target.value)}
                        className="rounded-lg border border-[var(--admin-border)] bg-[var(--admin-input-bg)] px-2 py-1.5 text-sm text-[var(--admin-text-primary)]"
                    >
                        <option value="all">All Actions</option>
                        {actionTypes.map(a => (
                            <option key={a} value={a}>{a}</option>
                        ))}
                    </select>

                    {/* Auto-refresh toggle */}
                    <label className="flex items-center gap-1.5 text-sm text-[var(--admin-text-secondary)] cursor-pointer">
                        <input
                            type="checkbox"
                            checked={autoRefresh}
                            onChange={e => setAutoRefresh(e.target.checked)}
                            className="rounded border-[var(--admin-border)]"
                        />
                        Auto
                    </label>

                    {/* Manual refresh */}
                    <button
                        onClick={() => loadEvents(limit)}
                        disabled={loading}
                        className="rounded-lg border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-1.5 text-sm text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)] disabled:opacity-50"
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

            {/* Events table */}
            {filteredEvents.length === 0 ? (
                <p className="text-[var(--admin-text-muted)]">No audit events found.</p>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-[var(--admin-border)]">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-[var(--admin-border)] bg-[var(--admin-surface)]">
                                <th className="px-3 py-2 text-left text-xs font-bold uppercase tracking-wider text-[var(--admin-text-muted)]">Time</th>
                                <th className="px-3 py-2 text-left text-xs font-bold uppercase tracking-wider text-[var(--admin-text-muted)]">Action</th>
                                <th className="px-3 py-2 text-left text-xs font-bold uppercase tracking-wider text-[var(--admin-text-muted)]">Admin</th>
                                <th className="px-3 py-2 text-left text-xs font-bold uppercase tracking-wider text-[var(--admin-text-muted)]">Status</th>
                                <th className="px-3 py-2 text-left text-xs font-bold uppercase tracking-wider text-[var(--admin-text-muted)]">IP</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredEvents.map((event) => (
                                <tr
                                    key={event.eventId}
                                    className="border-b border-[var(--admin-border)] transition hover:bg-[var(--admin-surface-hover)]"
                                >
                                    <td className="whitespace-nowrap px-3 py-2 text-[var(--admin-text-secondary)]">
                                        {formatTimestamp(event.timestamp)}
                                    </td>
                                    <td className="px-3 py-2 font-mono text-xs text-[var(--admin-text-primary)]">
                                        {formatAction(event)}
                                    </td>
                                    <td className="px-3 py-2 font-mono text-xs text-[var(--admin-text-muted)]">
                                        {event.adminId.substring(0, 8)}…
                                    </td>
                                    <td className="px-3 py-2">
                                        {event.statusCode && (
                                            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                                event.statusCode < 400
                                                    ? 'bg-[var(--admin-success-bg)] text-[var(--admin-success)]'
                                                    : 'bg-[var(--admin-danger-bg)] text-[var(--admin-danger-text)]'
                                            }`}>
                                                {event.statusCode}
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-3 py-2 text-xs text-[var(--admin-text-muted)]">
                                        {event.ip}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Load more */}
            {hasMore && filteredEvents.length > 0 && (
                <div className="mt-3 text-center">
                    <button
                        onClick={handleLoadMore}
                        disabled={loadingMore}
                        className="rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-4 py-2 text-sm text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)] disabled:opacity-50"
                    >
                        {loadingMore ? 'Loading...' : `Load More (showing ${filteredEvents.length})`}
                    </button>
                </div>
            )}
        </div>
    );
}
