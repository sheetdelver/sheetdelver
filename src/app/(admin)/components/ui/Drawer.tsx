'use client';

/**
 * Drawer — right-hand slide-over panel (ADR-0030 UX-5).
 *
 * Hosts module detail/operations out of the inline list accordion so the list
 * stays scannable. Closes on backdrop click or the close button.
 */

import React, { useEffect, useRef } from 'react';

export default function Drawer({
    open,
    title,
    onClose,
    returnFocus,
    children,
}: {
    open: boolean;
    title: string;
    onClose: () => void;
    returnFocus?: HTMLElement | null;
    children: React.ReactNode;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        if (!open || !dialog.current) return;
        const previous = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        const element = dialog.current;
        element.showModal();
        return () => { element.close(); if (previous?.isConnected) previous.focus(); };
    }, [open, returnFocus]);
    if (!open) return null;

    return (
        <dialog ref={dialog} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}
            className="fixed inset-0 m-0 flex h-full max-h-none w-full max-w-none justify-end bg-transparent p-0 text-[var(--admin-text-primary)]">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/40"
                onClick={onClose}
                aria-hidden="true"
            />
            {/* Panel */}
            <div
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
        </dialog>
    );
}
