'use client';

import { useAdminTheme } from '../context/AdminThemeContext';

export default function AdminThemeToggle() {
  const { theme, toggleTheme } = useAdminTheme();
  const nextThemeLabel = theme === 'dark' ? 'Light' : 'Dark';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--admin-border-strong)] bg-[var(--admin-surface-strong)] text-[var(--admin-text-primary)] shadow-[0_10px_30px_rgba(15,23,42,0.12)] transition hover:bg-[var(--admin-surface-hover)]"
      aria-label={`Switch admin theme to ${nextThemeLabel}`}
      title={`Switch to ${nextThemeLabel.toLowerCase()} theme`}
    >
      {theme === 'dark' ? (
        // Sun icon — shown in dark mode (click to go light)
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <circle cx="12" cy="12" r="4" strokeWidth={2} />
          <path strokeLinecap="round" strokeWidth={2} d="M12 2v2m0 16v2m10-10h-2M4 12H2m15.07-7.07l-1.41 1.41M6.34 17.66l-1.41 1.41m12.73 0l-1.41-1.41M6.34 6.34L4.93 4.93" />
        </svg>
      ) : (
        // Moon icon — shown in light mode (click to go dark)
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
        </svg>
      )}
    </button>
  );
}