'use client';

/**
 * AdminTopBar
 *
 * Sticky global context bar (ADR-0030 UX-2). Carries brand, environment badge,
 * Core Service connection indicator, current operator identity, theme toggle,
 * and logout — kept visible regardless of scroll. Also renders a single
 * top-level offline banner when the Core Service is unreachable, so individual
 * panels don't each surface their own disconnected error.
 *
 * Polls admin status independently for the connection/environment signals; a
 * shared status context can replace this in UX-5's unified-refresh work.
 */

import React, { useEffect, useState } from 'react';
import { useAdminAuth } from '../context/AdminAuthContext';
import { fetchAdminStatus } from '../lib/adminApi';
import AdminThemeToggle from './AdminThemeToggle';
import Button from './ui/Button';

const STATUS_POLL_MS = 10_000;

export default function AdminTopBar() {
    const { adminId, logout } = useAdminAuth();
    const [connected, setConnected] = useState<boolean | null>(null);
    const [environment, setEnvironment] = useState<'development' | 'production' | null>(null);
    const [reachable, setReachable] = useState(true);

    useEffect(() => {
        let active = true;
        const poll = async () => {
            const result = await fetchAdminStatus();
            if (!active) return;
            if (result.sessionExpired) {
                logout();
                return;
            }
            if (result.ok && result.data) {
                setReachable(true);
                setConnected(!!result.data.connected);
                setEnvironment(result.data.environment ?? null);
            } else {
                // Network/5xx — Core Service unreachable.
                setReachable(false);
            }
        };
        poll();
        const interval = setInterval(poll, STATUS_POLL_MS);
        return () => { active = false; clearInterval(interval); };
    }, [logout]);

    return (
        <header className="sticky top-0 z-40">
            <div className="flex items-center gap-3 border-b border-[var(--admin-border)] bg-[var(--admin-surface-strong)] px-4 py-2.5 backdrop-blur-md">
                {/* Brand */}
                <div className="flex items-center gap-2 font-bold tracking-tight text-[var(--admin-text-primary)]">
                    <span aria-hidden="true">◆</span>
                    <span>SheetDelver Admin</span>
                </div>

                {/* Environment badge */}
                {environment && (
                    <span
                        className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase tracking-wider ${
                            environment === 'production'
                                ? 'bg-[var(--admin-danger-bg)] text-[var(--admin-danger-text)] border border-[var(--admin-danger-border)]'
                                : 'bg-[var(--admin-warning-bg)] text-[var(--admin-warning-text)] border border-[var(--admin-warning-border)]'
                        }`}
                        title={`Environment: ${environment}`}
                    >
                        {environment === 'production' ? 'PROD' : 'DEV'}
                    </span>
                )}

                {/* Connection indicator */}
                <span className="flex items-center gap-1.5 text-xs text-[var(--admin-text-secondary)]" title="Core Service connection">
                    <span
                        className={`inline-block h-2 w-2 rounded-full ${
                            reachable && connected
                                ? 'bg-[var(--admin-success)]'
                                : reachable
                                    ? 'bg-amber-400'
                                    : 'bg-[var(--admin-danger-button)]'
                        }`}
                        aria-hidden="true"
                    />
                    {!reachable ? 'Core: Offline' : connected ? 'Core: Connected' : 'Core: Disconnected'}
                </span>

                {/* Right cluster */}
                <div className="ml-auto flex items-center gap-3">
                    {adminId && (
                        <span className="hidden font-mono text-xs text-[var(--admin-text-muted)] sm:inline" title="Signed-in admin">
                            {adminId}
                        </span>
                    )}
                    <AdminThemeToggle />
                    <Button variant="secondary" size="sm" onClick={logout}>
                        Logout
                    </Button>
                </div>
            </div>

            {/* Offline banner */}
            {!reachable && (
                <div
                    role="alert"
                    className="border-b border-[var(--admin-danger-border)] bg-[var(--admin-danger-bg)] px-4 py-2 text-center text-sm font-medium text-[var(--admin-danger-text)]"
                >
                    Core Service is unreachable. Status and actions may be unavailable until it reconnects.
                </div>
            )}
        </header>
    );
}
