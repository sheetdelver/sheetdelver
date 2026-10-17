'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { AdminMigrationOverview } from '@shared/types/adminMigration';
import { adminFetch } from '../lib/adminApi';
import { useAdminAuth } from './AdminAuthContext';
import { useAdminRuntimeRestart } from './AdminRuntimeRestartContext';

interface Value { data: AdminMigrationOverview | null; error: string | null; loading: boolean; refresh: () => Promise<AdminMigrationOverview | null> }
const Context = createContext<Value | null>(null);
/** One admin-owned evidence poll, never a migration scan. Auth/runtime retirement
 * and overdue/failed reads clear the old display instead of retaining green. */
export function AdminMigrationProvider({ children }: { children: React.ReactNode }) {
    const { isAuthenticated, sessionRevision, isCurrentSession, logout } = useAdminAuth(); const { restarting } = useAdminRuntimeRestart();
    const [data, setData] = useState<AdminMigrationOverview | null>(null);
    const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(false);
    const sequence = useRef(0); const pending = useRef<AbortController | null>(null); const receivedAt = useRef(0);
    const retire = useCallback(() => { ++sequence.current; pending.current?.abort(); }, []);
    const refresh = useCallback(async () => {
        if (!isAuthenticated || restarting) return null;
        const id = ++sequence.current; pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
        setLoading(true);
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
            const result = await adminFetch<AdminMigrationOverview>('/module-migrations', { signal: controller.signal });
            if (id !== sequence.current || !isCurrentSession(sessionRevision)) return null;
            if (result.sessionExpired) { setData(null); logout(); return null; }
            if (!result.ok || !result.data || !Array.isArray(result.data.sources)) { setData(null); setError(result.error || 'Current migration status unavailable. No readiness is established.'); return null; }
            receivedAt.current = Date.now(); setData(result.data); setError(null); return result.data;
        } finally { clearTimeout(timeout); if (id === sequence.current) setLoading(false); }
    }, [isAuthenticated, sessionRevision, isCurrentSession, restarting, logout]);
    useEffect(() => {
        ++sequence.current; pending.current?.abort(); setData(null); setError(null); receivedAt.current = 0;
        if (!isAuthenticated || restarting) return;
        let active = true; let timer: ReturnType<typeof setTimeout>;
        const poll = async () => { if (document.visibilityState !== 'hidden') await refresh(); if (active) timer = setTimeout(poll, 5000); };
        const wake = () => { if (document.visibilityState !== 'hidden') { setData(null); void refresh(); } };
        const freshness = setInterval(() => { if (receivedAt.current && Date.now() - receivedAt.current > 15_000) { setData(null); setError('Status refresh overdue. Check connectivity; no current readiness is established.'); } }, 1000);
        void poll(); window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake);
        return () => { active = false; clearTimeout(timer); clearInterval(freshness); retire();
            window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); };
    }, [isAuthenticated, restarting, refresh, retire]);
    return <Context.Provider value={{ data, error, loading, refresh }}>{children}</Context.Provider>;
}
export function useAdminMigration() { const value = useContext(Context); if (!value) throw new Error('AdminMigrationProvider required'); return value; }
