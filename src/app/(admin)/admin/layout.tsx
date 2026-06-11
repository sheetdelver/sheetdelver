'use client';

/**
 * Authenticated admin shell (ADR-0030 UX-3).
 *
 * Wraps every /admin/* route: gates on auth (loading → login → shell) once for
 * all sub-pages, and provides the persistent chrome — sticky top bar plus the
 * left sidebar — with the routed page content rendered in the main area.
 */

import { useAdminAuth } from '../context/AdminAuthContext';
import AdminLoginForm from '../components/AdminLoginForm';
import AdminTopBar from '../components/AdminTopBar';
import AdminSidebar from '../components/AdminSidebar';

export default function AdminAreaLayout({ children }: { children: React.ReactNode }) {
    const { isAuthenticated, loading, accountExists } = useAdminAuth();

    if (loading) {
        return (
            <div className="admin-screen min-h-screen flex items-center justify-center">
                <div className="rounded-lg border border-[var(--admin-border)] bg-[var(--admin-surface)] px-5 py-4 text-[var(--admin-text-secondary)] shadow-sm">
                    Loading...
                </div>
            </div>
        );
    }

    if (!isAuthenticated) {
        return <AdminLoginForm accountExists={accountExists ?? true} />;
    }

    return (
        <div className="admin-screen min-h-screen flex flex-col">
            <AdminTopBar />
            <div className="flex flex-1 items-stretch">
                <AdminSidebar />
                <main className="flex-1 min-w-0 p-6">
                    <div className="mx-auto max-w-5xl">{children}</div>
                </main>
            </div>
        </div>
    );
}
