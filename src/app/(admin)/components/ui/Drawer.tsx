'use client';

/**
 * Drawer — right-hand slide-over panel (ADR-0030 UX-5).
 *
 * Hosts module detail/operations out of the inline list accordion so the list
 * stays scannable. Closes on backdrop click or the close button.
 */

import React from 'react';

export default function Drawer({
    open,
    title,
    onClose,
    children,
}: {
    open: boolean;
    title: string;
    onClose: () => void;
    children: React.ReactNode;
}) {
    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex justify-end">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/40"
                onClick={onClose}
                aria-hidden="true"
            />
            {/* Panel */}
            <div
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className="relative flex h-full w-full max-w-xl flex-col border-l border-[var(--admin-border)] bg-[var(--admin-bg)] shadow-xl"
            >
                <div className="flex items-center justify-between border-b border-[var(--admin-border)] px-5 py-3">
                    <h2 className="text-lg font-bold tracking-tight text-[var(--admin-text-primary)]">{title}</h2>
                    <button
                        onClick={onClose}
                        aria-label="Close detail panel"
                        className="rounded-md px-2 py-1 text-xl leading-none text-[var(--admin-text-muted)] transition hover:bg-[var(--admin-surface-hover)] hover:text-[var(--admin-text-primary)]"
                    >
                        &times;
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-5">{children}</div>
            </div>
        </div>
    );
}
