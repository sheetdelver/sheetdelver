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
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import ErrorState from './ui/ErrorState';

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
    const [search, setSearch] = useState('');
    const [autoRefresh, setAutoRefresh] = useState(false);
    const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [nowTick, setNowTick] = useState(Date.now());

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
            setLastLoadedAt(Date.now());
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

    // Tick once a second so the "updated Ns ago" label stays current.
    useEffect(() => {
        const t = setInterval(() => setNowTick(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

    // ─── Derive unique action types for filter ─────────────────────

    const actionTypes = Array.from(new Set(events.map(e => formatAction(e)))).sort();

    // ─── Filter events ─────────────────────────────────────────────

    const searchLower = search.trim().toLowerCase();
    const filteredEvents = events.filter(e => {
        if (filterAction !== 'all' && formatAction(e) !== filterAction) return false;
        if (searchLower) {
            const haystack = `${e.method} ${e.path} ${e.adminId} ${e.ip} ${e.statusCode}`.toLowerCase();
            if (!haystack.includes(searchLower)) return false;
        }
        return true;
    });

    const updatedAgoLabel = lastLoadedAt
        ? `updated ${Math.max(0, Math.round((nowTick - lastLoadedAt) / 1000))}s ago`
        : null;

    // ─── Loading ───────────────────────────────────────────────────

    if (loading && events.length === 0) {
        return (
            <div className="p-4">
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
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
                <div className="flex flex-wrap items-center gap-2">
                    {updatedAgoLabel && (
                        <span className="text-xs text-[var(--admin-text-muted)]">{updatedAgoLabel}</span>
                    )}
                    {/* Text search */}
                    <input
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search path / admin / IP…"
                        aria-label="Search audit events"
                        className="rounded-lg border border-[var(--admin-border)] bg-[var(--admin-input-bg)] px-2 py-1.5 text-sm text-[var(--admin-text-primary)] placeholder-[var(--admin-text-muted)]"
                    />
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
                    <Button variant="secondary" size="sm" onClick={() => loadEvents(limit)} disabled={loading}>
                        Refresh
                    </Button>
                </div>
            </div>

            {/* Error */}
            {error && <ErrorState message={error} className="mb-4" />}

            {/* Events table */}
            {filteredEvents.length === 0 ? (
                <EmptyState message="No audit events found." />
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
                            {filteredEvents.map((event) => {
                                const isExpanded = expandedId === event.eventId;
                                return (
                                <React.Fragment key={event.eventId}>
                                <tr
                                    onClick={() => setExpandedId(isExpanded ? null : event.eventId)}
                                    aria-expanded={isExpanded}
                                    className="cursor-pointer border-b border-[var(--admin-border)] transition hover:bg-[var(--admin-surface-hover)]"
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
                                {isExpanded && (
                                    <tr className="border-b border-[var(--admin-border)] bg-[var(--admin-surface)]">
                                        <td colSpan={5} className="px-3 py-3">
                                            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                                                <DetailRow label="Event ID" value={event.eventId} />
                                                <DetailRow label="Admin" value={event.adminId} />
                                                <DetailRow label="Method / Path" value={`${event.method} ${event.path}`} />
                                                <DetailRow label="Outcome" value={event.outcome ?? '—'} />
                                                <DetailRow label="Status" value={String(event.statusCode ?? '—')} />
                                                <DetailRow label="Duration" value={event.durationMs != null ? `${event.durationMs} ms` : '—'} />
                                                <DetailRow label="IP" value={event.ip} />
                                                <DetailRow label="User agent" value={event.userAgent ?? '—'} />
                                            </dl>
                                        </td>
                                    </tr>
                                )}
                                </React.Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Load more */}
            {hasMore && filteredEvents.length > 0 && (
                <div className="mt-3 text-center">
                    <Button variant="secondary" size="sm" onClick={handleLoadMore} disabled={loadingMore}>
                        {loadingMore ? 'Loading...' : `Load More (showing ${filteredEvents.length})`}
                    </Button>
                </div>
            )}
        </div>
    );
}

/** Key/value row for the expanded audit event detail. */
function DetailRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex gap-2">
            <dt className="shrink-0 font-semibold text-[var(--admin-text-muted)]">{label}:</dt>
            <dd className="font-mono break-all text-[var(--admin-text-secondary)]">{value}</dd>
        </div>
    );
}
