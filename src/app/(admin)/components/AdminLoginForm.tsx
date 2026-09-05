'use client';

import React, { useState } from 'react';
import { useAdminAuth } from '../context/AdminAuthContext';
import AdminThemeToggle from './AdminThemeToggle';

interface AdminLoginFormProps {
  accountExists?: boolean;
}

export default function AdminLoginForm({ accountExists = true }: AdminLoginFormProps) {
  const { login, error, loading } = useAdminAuth();
  const [password, setPassword] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (accountExists === false) {
    return <AdminSetupForm />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    try {
      await login(password);
      setPassword('');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Login failed');
    }
  };

  return (
    <div className="admin-screen min-h-screen flex items-center justify-center p-4">
      <div className="admin-panel relative w-full max-w-md rounded-xl p-8 shadow-sm">
        <div className="mb-6 flex justify-end">
          <AdminThemeToggle />
        </div>

        <h1 className="mb-6 text-center text-3xl font-bold tracking-tight text-[var(--admin-text-primary)]">Admin Login</h1>

        {(error || submitError) && (
          <div className="mb-4 rounded-lg border border-[var(--admin-danger-border)] bg-[var(--admin-danger-bg)] p-3 text-[var(--admin-danger-text)]">
            {error || submitError}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="password" className="mb-2 block text-sm font-semibold text-[var(--admin-text-primary)]">
              Admin Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              required
              className="w-full rounded-lg border border-[var(--admin-border-strong)] bg-[var(--admin-input-bg)] px-4 py-3 text-[var(--admin-text-primary)] placeholder:text-[var(--admin-text-muted)] focus:border-[var(--admin-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--admin-accent-soft)] disabled:cursor-not-allowed disabled:opacity-60"
              placeholder="Enter admin password"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !password}
            className="w-full rounded-lg bg-[var(--admin-accent)] px-4 py-3 font-semibold text-white transition hover:bg-[var(--admin-accent-strong)] disabled:cursor-not-allowed disabled:bg-[var(--admin-accent-soft)] disabled:text-white/80"
          >
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs leading-5 text-[var(--admin-text-muted)]">
          Admin credentials required. Contact your Foundry server administrator if you do not have access.
        </p>
      </div>
    </div>
  );
}

function AdminSetupForm() {
  const { initSetup, error, setupInProgress } = useAdminAuth();
  const [password, setPassword] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    try {
      await initSetup(bootstrapToken, password);
      setPassword('');
      setBootstrapToken('');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Setup failed');
    }
  };

  return (
    <div className="admin-screen min-h-screen flex items-center justify-center p-4">
      <div className="admin-panel relative w-full max-w-md rounded-xl p-8 shadow-sm">
        <div className="mb-6 flex justify-end">
          <AdminThemeToggle />
        </div>

        <h1 className="mb-2 text-center text-3xl font-bold tracking-tight text-[var(--admin-text-primary)]">Admin Setup</h1>
        <p className="mb-6 text-center text-sm text-[var(--admin-text-secondary)]">
          Create your admin account to manage modules
        </p>

        {(error || submitError) && (
          <div className="mb-4 rounded-lg border border-[var(--admin-danger-border)] bg-[var(--admin-danger-bg)] p-3 text-sm text-[var(--admin-danger-text)]">
            {error || submitError}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="bootstrapToken" className="mb-2 block text-sm font-semibold text-[var(--admin-text-primary)]">
              Bootstrap Token
            </label>
            <input
              id="bootstrapToken"
              type="password"
              value={bootstrapToken}
              onChange={(e) => setBootstrapToken(e.target.value)}
              disabled={setupInProgress}
              required
              className="w-full rounded-lg border border-[var(--admin-border-strong)] bg-[var(--admin-input-bg)] px-4 py-3 text-sm text-[var(--admin-text-primary)] placeholder:text-[var(--admin-text-muted)] focus:border-[var(--admin-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--admin-accent-soft)] disabled:cursor-not-allowed disabled:opacity-60"
              placeholder="Enter the one-time CLI token"
            />
            <p className="mt-1 text-xs text-[var(--admin-text-muted)]">
              Issued locally with npm run admin:bootstrap
            </p>
          </div>

          <div>
            <label htmlFor="password" className="mb-2 block text-sm font-semibold text-[var(--admin-text-primary)]">
              Admin Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={setupInProgress}
              required
              className="w-full rounded-lg border border-[var(--admin-border-strong)] bg-[var(--admin-input-bg)] px-4 py-3 text-[var(--admin-text-primary)] placeholder:text-[var(--admin-text-muted)] focus:border-[var(--admin-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--admin-accent-soft)] disabled:cursor-not-allowed disabled:opacity-60"
              placeholder="Create your admin password"
            />
            <p className="mt-1 text-xs text-[var(--admin-text-muted)]">
              At least 8 characters recommended
            </p>
          </div>

          <button
            type="submit"
            disabled={setupInProgress || !password || !bootstrapToken}
            className="w-full rounded-lg bg-[var(--admin-success)] px-4 py-3 font-semibold text-white transition hover:bg-[var(--admin-success-strong)] disabled:cursor-not-allowed disabled:bg-[var(--admin-success-soft)] disabled:text-white/80"
          >
            {setupInProgress ? 'Setting up...' : 'Create Account'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs leading-5 text-[var(--admin-text-muted)]">
          This is a one-time setup. Your password will be securely hashed using Argon2.
        </p>
      </div>
    </div>
  );
}
