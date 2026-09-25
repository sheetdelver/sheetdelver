import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface ConfirmationModalProps {
    isOpen: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
    isDanger?: boolean;
    theme?: {
        overlay?: string;
        container?: string;
        header?: string;
        title?: string;
        body?: string;
        footer?: string;
        confirmBtn?: (isDanger?: boolean) => string;
        cancelBtn?: string;
        closeBtn?: string;
    };
}

const defaultTheme = {
    overlay: "absolute inset-0 bg-black/60 backdrop-blur-md transition-opacity",
    container: "relative z-10 bg-neutral-900/95 backdrop-blur-xl border border-white/10 shadow-2xl rounded-2xl w-full max-w-md p-6 animate-in fade-in zoom-in-95 duration-200",
    header: "flex justify-between items-center border-b border-white/5 pb-3 mb-4",
    title: "font-sans font-bold text-xl text-white",
    body: "text-neutral-400 font-sans mb-8 leading-relaxed",
    footer: "flex justify-end gap-3",
    confirmBtn: (isDanger?: boolean) => `px-6 py-2.5 font-bold font-sans rounded-xl transition-all active:scale-95 ${isDanger ? 'bg-red-500 hover:bg-red-600 text-white shadow-lg shadow-red-500/20' : 'bg-white hover:bg-neutral-200 text-neutral-900 shadow-lg shadow-white/5'}`,
    cancelBtn: "px-5 py-2.5 font-bold font-sans rounded-xl border border-white/10 hover:bg-white/5 transition-all text-neutral-400 hover:text-white",
    closeBtn: "text-neutral-500 hover:text-white transition-colors"
};

export function ConfirmationModal({
    isOpen,
    title,
    message,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    onConfirm,
    onCancel,
    isDanger = false,
    theme
}: ConfirmationModalProps) {
    const [mounted, setMounted] = useState(false);
    const t = { ...defaultTheme, ...theme };

    useEffect(() => {
        setMounted(true);
        return () => setMounted(false);
    }, []);

    // Prevent scrolling when modal is open
    useEffect(() => {
        if (isOpen) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }
        return () => { document.body.style.overflow = ''; };
    }, [isOpen]);

    if (!mounted || !isOpen) return null;

    return createPortal(
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
            {/* Overlay background - absolute to parent fixed wrapper */}
            <div
                className={t.overlay}
                onClick={onCancel}
            />

            {/* Modal Card - relative z-10 for sharp text above blur/overlay */}
            <div className={t.container}>
                <div className={t.header}>
                    <h3 className={t.title}>
                        {title}
                    </h3>
                    <button
                        onClick={onCancel}
                        className={t.closeBtn || "text-neutral-400 hover:text-white transition-colors"}
                        aria-label="Close"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                        </svg>
                    </button>
                </div>

                <p className={t.body}>
                    {message}
                </p>

                <div className={t.footer}>
                    <button
                        onClick={onCancel}
                        className={t.cancelBtn}
                    >
                        {cancelLabel}
                    </button>
                    <button
                        onClick={onConfirm}
                        className={t.confirmBtn ? t.confirmBtn(isDanger) : defaultTheme.confirmBtn(isDanger)}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}
