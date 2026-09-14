'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fetchAdminStatus } from '../lib/adminApi';
import { isRuntimeRestartReady } from '@shared/runtime/fullStackRestart';

interface AdminRuntimeRestartContextValue {
    beginRuntimeRestart: () => void;
}

const AdminRuntimeRestartContext = createContext<AdminRuntimeRestartContextValue | undefined>(undefined);

export function AdminRuntimeRestartProvider({ children }: { children: React.ReactNode }) {
    const [restarting, setRestarting] = useState(false);
    const beginRuntimeRestart = useCallback(() => setRestarting(true), []);

    useEffect(() => {
        if (!restarting) return;

        let active = true;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const poll = async () => {
            try {
                const status = await fetchAdminStatus();
                if (active && status.ok && status.data && isRuntimeRestartReady(status.data)) {
                    window.location.reload();
                    return;
                }
            } catch {
                // The stack is expected to be unreachable during replacement.
            }

            if (active) timer = setTimeout(poll, 1_000);
        };

        // Core waits 500 ms before exiting. Delay the first read so it cannot
        // mistake the draining process for the replacement runtime.
        timer = setTimeout(poll, 1_000);
        return () => {
            active = false;
            if (timer) clearTimeout(timer);
        };
    }, [restarting]);

    return (
        <AdminRuntimeRestartContext.Provider value={{ beginRuntimeRestart }}>
            {children}
            {restarting && (
                <div
                    className="fixed inset-0 z-[250] flex items-center justify-center bg-neutral-950/95 px-6 text-white"
                    role="status"
                    aria-live="assertive"
                >
                    <div className="flex max-w-md flex-col items-center gap-4 text-center">
                        <Loader2 className="h-10 w-10 animate-spin text-amber-400" aria-hidden="true" />
                        <h2 className="text-2xl font-bold">Applying module changes</h2>
                        <p className="text-sm text-neutral-300">
                            The administration panel will resume when the world runtime is ready.
                        </p>
                    </div>
                </div>
            )}
        </AdminRuntimeRestartContext.Provider>
    );
}

export function useAdminRuntimeRestart() {
    const context = useContext(AdminRuntimeRestartContext);
    if (!context) {
        throw new Error('useAdminRuntimeRestart must be used within AdminRuntimeRestartProvider');
    }
    return context;
}
