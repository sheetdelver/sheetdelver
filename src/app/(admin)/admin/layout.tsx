'use client';

/**
 * Authenticated admin shell (ADR-0030 UX-3).
 *
 * Wraps every /admin/* route: gates on auth (loading -> login -> shell) once
 * for all sub-pages and keeps player runtime providers outside this graph.
 */

import { useAdminAuth } from '../context/AdminAuthContext';
import AdminLoginForm from '../components/AdminLoginForm';
import AdminTopBar from '../components/AdminTopBar';
import AdminSidebar from '../components/AdminSidebar';
import MigrationAttentionNotice from '../components/MigrationAttentionNotice';
import { usePathname } from 'next/navigation';

export default function AdminAreaLayout({ children }: { children: React.ReactNode }) {
    const { isAuthenticated, loading, accountExists } = useAdminAuth();
    const pathname = usePathname();

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
            <div className="flex flex-1 flex-col items-stretch md:flex-row">
                <AdminSidebar />
                <main className="min-w-0 flex-1 p-4 sm:p-6">
                    <div className="mx-auto max-w-5xl">{pathname !== '/admin/modules' && <MigrationAttentionNotice />}{children}</div>
                </main>
            </div>
        </div>
    );
}
