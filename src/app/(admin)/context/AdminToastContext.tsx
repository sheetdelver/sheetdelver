'use client';

import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { NotificationType } from '@shared/types/modules';

export type ToastType = NotificationType;

interface Toast {
    id: string;
    type: ToastType;
    message: string;
}

interface AdminToastContextValue {
    addToast: (message: string, type?: ToastType) => void;
}

// ─── Context ──────────────────────────────────────────────────────

const AdminToastContext = createContext<AdminToastContextValue | undefined>(undefined);

export function useAdminToast() {
    const ctx = useContext(AdminToastContext);
    if (!ctx) throw new Error('useAdminToast must be used inside AdminToastProvider');
    return ctx;
}

// ─── Provider ─────────────────────────────────────────────────────

const DURATION_MS = 4000;

export function AdminToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const counterRef = useRef(0);

    const remove = useCallback((id: string) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    }, []);

    const addToast = useCallback((message: string, type: ToastType = NotificationType.Info) => {
        const id = `toast-${++counterRef.current}`;
        setToasts(prev => [...prev, { id, type, message }]);
        setTimeout(() => remove(id), DURATION_MS);
    }, [remove]);

    return (
        <AdminToastContext.Provider value={{ addToast }}>
            {children}

            {/* Toast stack — fixed top-right, stacks downward */}
            <div
                aria-live="polite"
                className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 w-80 pointer-events-none"
            >
                {toasts.map(toast => (
                    <div
                        key={toast.id}
                        className={`pointer-events-auto flex items-start gap-3 rounded-2xl border px-4 py-3 shadow-lg backdrop-blur-sm text-sm transition-all animate-in slide-in-from-right-4 ${
                            toast.type === NotificationType.Success
                                ? 'border-[var(--admin-success-border)] bg-[var(--admin-success-bg)] text-[var(--admin-success)]'
                                : toast.type === NotificationType.Error
                                    ? 'border-[var(--admin-danger-border)] bg-[var(--admin-danger-bg)] text-[var(--admin-danger-text)]'
                                    : 'border-[var(--admin-border)] bg-[var(--admin-surface)] text-[var(--admin-text-primary)]'
                        }`}
                    >
                        {/* Icon */}
                        <span className="mt-0.5 shrink-0 text-base leading-none">
                            {toast.type === NotificationType.Success ? '✓' : toast.type === NotificationType.Error ? '✕' : 'ℹ'}
                        </span>

                        <span className="flex-1">{toast.message}</span>

                        <button
                            onClick={() => remove(toast.id)}
                            className="shrink-0 opacity-50 hover:opacity-100 leading-none text-lg"
                        >
                            &times;
                        </button>
                    </div>
                ))}
            </div>
        </AdminToastContext.Provider>
    );
}
