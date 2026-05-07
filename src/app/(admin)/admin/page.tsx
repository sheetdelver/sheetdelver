'use client';

/**
 * Admin Dashboard Page
 *
 * Organizes all admin panels into a coherent dashboard layout with
 * collapsible sections, responsive design, and session expiry handling.
 */

import { useState, useCallback } from 'react';
import { useAdminAuth } from '../context/AdminAuthContext';
import AdminLoginForm from '../components/AdminLoginForm';
import AdminThemeToggle from '../components/AdminThemeToggle';
import SystemInfoCard from '../components/SystemInfoCard';
import WorldManagementPanel from '../components/WorldManagementPanel';
import ModuleLifecycleControl from '../components/ModuleLifecycleControl';
import AuditLogViewer from '../components/AuditLogViewer';
import CacheInfoPanel from '../components/CacheInfoPanel';
import SourceProfilePanel from '../components/SourceProfilePanel';
import RestartModal from '../components/RestartModal';
import { type ModuleLifecycleInfo } from '../lib/adminApi';

/** Chevron icon for collapsible section headers. */
function ChevronIcon({ expanded }: { expanded: boolean }) {
    return (
        <svg
            className={`h-5 w-5 text-[var(--admin-text-muted)] transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
        >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
    );
}

/** Collapsible section wrapper with header toggle. */
function DashboardSection({
    title,
    defaultExpanded = true,
    children,
}: {
    title: string;
    defaultExpanded?: boolean;
    children: React.ReactNode;
}) {
    const [expanded, setExpanded] = useState(defaultExpanded);

    return (
        <section className="admin-panel rounded-[28px] shadow-[0_24px_80px_rgba(15,23,42,0.18)] overflow-hidden">
            {/* Clickable header */}
            <button
                onClick={() => setExpanded(!expanded)}
                className="flex w-full items-center gap-2 px-6 py-4 text-left transition hover:bg-[var(--admin-surface-hover)]"
            >
                <ChevronIcon expanded={expanded} />
                <span className="text-lg font-bold tracking-tight text-[var(--admin-text-primary)]">{title}</span>
            </button>

            {/* Collapsible content */}
            {expanded && (
                <div className="px-2 pb-4">
                    {children}
                </div>
            )}
        </section>
    );
}

export default function AdminPage() {
    const { isAuthenticated, loading, accountExists, logout } = useAdminAuth();
    const [refreshKey, setRefreshKey] = useState(0);
    const triggerRefresh = useCallback(() => setRefreshKey(prev => prev + 1), []);

    const [installedModules, setInstalledModules] = useState<ModuleLifecycleInfo[]>([]);
    const handleModulesLoaded = useCallback((modules: ModuleLifecycleInfo[]) => {
        setInstalledModules(modules);
    }, []);

    // Manual restart state — no operations auto-trigger this; it can be wired to
    // a dedicated "Restart Server" button in the future if needed.
    const [restartOperation, setRestartOperation] = useState<string | null>(null);

    // ─── Loading state ─────────────────────────────────────────────

    if (loading) {
        return (
            <div className="admin-screen min-h-screen flex items-center justify-center">
                <div className="rounded-2xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-5 py-4 text-[var(--admin-text-secondary)] shadow-[0_18px_60px_rgba(15,23,42,0.14)]">
                    Loading...
                </div>
            </div>
        );
    }

    // ─── Auth gate ─────────────────────────────────────────────────

    if (!isAuthenticated) {
        return <AdminLoginForm accountExists={accountExists ?? true} />;
    }

    // ─── Dashboard ─────────────────────────────────────────────────

    return (
        <main className="admin-screen min-h-screen">
            {/* Modal restart prompt — appears after install/upgrade/uninstall */}
            {restartOperation && (
                <RestartModal
                    operation={restartOperation}
                    onDismiss={() => setRestartOperation(null)}
                />
            )}

            <div className="mx-auto max-w-5xl p-6">
                {/* Header */}
                <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div>
                        <h1 className="mb-1 text-4xl font-bold tracking-tight text-[var(--admin-text-primary)]">
                            Admin Dashboard
                        </h1>
                        <p className="text-[var(--admin-text-secondary)]">
                            System administration and lifecycle management
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
                        <AdminThemeToggle />
                        <button
                            onClick={logout}
                            className="rounded-2xl bg-[var(--admin-danger-button)] px-4 py-2 font-semibold text-white transition hover:bg-[var(--admin-danger-button-strong)]"
                        >
                            Logout
                        </button>
                    </div>
                </div>

                {/* Dashboard sections */}
                <div className="space-y-6">
                    {/* System Overview — always visible (no collapse header) */}
                    <section className="admin-panel rounded-[28px] p-6 shadow-[0_24px_80px_rgba(15,23,42,0.18)]">
                        <SystemInfoCard />
                    </section>

                    {/* World Management */}
                    <DashboardSection title="World Management" defaultExpanded={true}>
                        <WorldManagementPanel />
                    </DashboardSection>

                    {/* Module Lifecycle */}
                    <DashboardSection title="Module Lifecycle" defaultExpanded={true}>
                        <ModuleLifecycleControl
                            key={`lifecycle-${refreshKey}`}
                            onModulesLoaded={handleModulesLoaded}
                        />
                    </DashboardSection>

                    {/* Source Profiles */}
                    <DashboardSection title="Source Profiles" defaultExpanded={false}>
                        <SourceProfilePanel
                            onModuleInstalled={triggerRefresh}
                            installedModules={installedModules}
                        />
                    </DashboardSection>

                    {/* Audit Log — collapsed by default */}
                    <DashboardSection title="Audit Log" defaultExpanded={false}>
                        <AuditLogViewer />
                    </DashboardSection>

                    {/* Cache Info — collapsed by default */}
                    <DashboardSection title="Cache Info" defaultExpanded={false}>
                        <CacheInfoPanel />
                    </DashboardSection>
                </div>
            </div>
        </main>
    );
}
