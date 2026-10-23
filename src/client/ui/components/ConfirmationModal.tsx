import React, { useEffect, useRef, useState, useId } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from '../hooks/useModalFocus';
import { acquireBodyScrollLock } from '../hooks/bodyScrollLock';

interface ConfirmationModalProps {
    /** Use above a native dialog; z-index alone cannot escape its top layer. */
    topLayer?: boolean;
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
    overlay: "sd-ui-overlay absolute inset-0 backdrop-blur-md transition-opacity",
    container: "sd-ui-modal sd-ui-panel-raised relative z-10 backdrop-blur-xl shadow-2xl rounded-2xl w-full max-w-md p-6 animate-in fade-in zoom-in-95 duration-200",
    header: "flex justify-between items-center border-b sd-ui-divider pb-3 mb-4",
    title: "font-sans font-bold text-xl",
    body: "sd-ui-muted font-sans mb-8 leading-relaxed",
    footer: "flex justify-end gap-3",
    confirmBtn: (isDanger?: boolean) => `sd-ui-button ${isDanger ? 'sd-ui-button-danger' : 'sd-ui-button-primary'} px-6 py-2.5 font-bold font-sans rounded-xl transition-all active:scale-95`,
    cancelBtn: "sd-ui-button px-5 py-2.5 font-bold font-sans rounded-xl transition-all",
    closeBtn: "sd-ui-muted hover:opacity-80 transition-opacity"
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
    topLayer = false,
    theme
}: ConfirmationModalProps) {
    const [mounted, setMounted] = useState(false);
    const t = { ...defaultTheme, ...theme };
    const id = useId();

    useEffect(() => {
        setMounted(true);
        return () => setMounted(false);
    }, []);

    // Prevent scrolling when modal is open
    useEffect(() => {
        if (!isOpen) return;
        return acquireBodyScrollLock();
    }, [isOpen]);

    if (!mounted || !isOpen) return null;

    const content = (
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
            {/* Overlay background - absolute to parent fixed wrapper */}
            <div
                className={t.overlay}
                onClick={onCancel}
            />

            {/* Modal Card - relative z-10 for sharp text above blur/overlay */}
            <div className={t.container} role={topLayer ? undefined : 'alertdialog'} aria-modal={topLayer ? undefined : true} aria-labelledby={`${id}-title`} aria-describedby={`${id}-message`}>
                <div className={t.header}>
                    <h3 id={`${id}-title`} className={t.title}>
                        {title}
                    </h3>
                    <button
                        onClick={onCancel}
                        className={t.closeBtn}
                        aria-label="Close"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                        </svg>
                    </button>
                </div>

                <p id={`${id}-message`} className={t.body}>
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
        </div>
    );
    return createPortal(topLayer
        ? <TopLayerConfirmation titleId={`${id}-title`} messageId={`${id}-message`} onCancel={onCancel}>{content}</TopLayerConfirmation>
        : content, document.body);
}

function TopLayerConfirmation({ titleId, messageId, onCancel, children }: {
    titleId: string; messageId: string; onCancel: () => void; children: React.ReactNode;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    useModalFocus(ref, true, onCancel);
    useEffect(() => {
        const previous = document.activeElement;
        const dialog = ref.current!;
        dialog.showModal();
        // Continue editing is the safe default (the first footer button).
        dialog.querySelector<HTMLButtonElement>('button:nth-last-child(2)')?.focus();
        return () => {
            dialog.close();
            if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
        };
    }, []);
    return <dialog ref={ref} role="alertdialog" aria-labelledby={titleId} aria-describedby={messageId}
        onCancel={event => { event.preventDefault(); event.stopPropagation(); onCancel(); }}
        style={{ width: '100vw', height: '100dvh', maxWidth: 'none', maxHeight: 'none', margin: 0, padding: 0, border: 0, background: 'transparent' }}>
        {children}
    </dialog>;
}
