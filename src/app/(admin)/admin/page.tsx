'use client';

import { useAdminAuth } from '../context/AdminAuthContext';
import AdminLoginForm from '../components/AdminLoginForm';
import ModuleLifecycleControl from '../components/ModuleLifecycleControl';
import AdminThemeToggle from '../components/AdminThemeToggle';
import SystemInfoCard from '../components/SystemInfoCard';

export default function AdminPage() {
  const { isAuthenticated, loading, accountExists, logout } = useAdminAuth();

  if (loading) {
    return (
      <div className="admin-screen min-h-screen flex items-center justify-center">
        <div className="rounded-2xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-5 py-4 text-[var(--admin-text-secondary)] shadow-[0_18px_60px_rgba(15,23,42,0.14)]">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AdminLoginForm accountExists={accountExists ?? true} />;
  }

  return (
    <main className="admin-screen min-h-screen p-6">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="mb-2 text-4xl font-bold tracking-tight text-[var(--admin-text-primary)]">Admin Dashboard</h1>
            <p className="text-[var(--admin-text-secondary)]">System administration and lifecycle management</p>
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

        <div className="mb-8">
          <div className="admin-panel rounded-[28px] p-6 shadow-[0_24px_80px_rgba(15,23,42,0.18)]">
            <SystemInfoCard />
          </div>
        </div>

        <div className="space-y-8">
          <section className="admin-panel rounded-[28px] p-6 shadow-[0_24px_80px_rgba(15,23,42,0.18)]">
            <ModuleLifecycleControl />
          </section>
        </div>
      </div>
    </main>
  );
}
