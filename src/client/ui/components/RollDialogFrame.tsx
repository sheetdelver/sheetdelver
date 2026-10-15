'use client';

import { useId, type ReactNode, type Ref } from 'react';
import type { SystemComponentStyles } from '@shared/sdk/interfaces';

export const defaultRollDialogTheme = {
    overlay: 'sd-ui-overlay absolute inset-0 backdrop-blur-sm transition-opacity',
    container: 'sd-ui-panel-raised w-full max-w-md relative z-10 backdrop-blur-xl shadow-2xl rounded-2xl p-6 animate-in zoom-in-95 duration-200',
    header: 'mb-6 border-b sd-ui-divider pb-3',
    title: 'font-sans text-2xl font-bold tracking-tight text-center',
    body: 'space-y-4 mb-8',
    inputGroup: 'grid grid-cols-3 items-center gap-4',
    label: 'sd-ui-muted col-span-1 font-bold text-xs uppercase tracking-widest',
    input: 'sd-ui-control col-span-2 p-2 rounded-xl font-sans text-lg transition-all',
    footer: 'flex flex-col gap-3',
    rollBtn: (mode: 'normal' | 'adv' | 'dis') => {
        const base = 'sd-ui-button flex-1 py-3 px-4 font-bold text-sm rounded-xl transition-all active:scale-95 shadow-sm ';
        return base + (mode === 'normal' ? 'sd-ui-button-primary' : mode === 'adv' ? 'sd-ui-success' : 'sd-ui-danger');
    },
    closeBtn: 'sd-ui-muted hover:opacity-80 transition-opacity',
    select: 'sd-ui-control w-full p-2 rounded-xl font-sans text-lg appearance-none cursor-pointer transition-all',
    selectArrow: 'sd-ui-muted absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none',
};

export const resolveRollDialogTheme = (theme?: SystemComponentStyles['rollDialog']) => ({ ...defaultRollDialogTheme, ...theme });

/** The existing SDK sheet roller's frame, also used by bounded initiative. */
export default function RollDialogFrame({ title, subtitle, theme, onClose, dialogRef,
    children, footer, layer = 100, closeLabel = 'Close' }: {
    title: string;
    subtitle?: string;
    theme?: SystemComponentStyles['rollDialog'];
    onClose: () => void;
    dialogRef?: Ref<HTMLDivElement>;
    children: ReactNode;
    footer: ReactNode;
    layer?: number;
    closeLabel?: string;
}) {
    const titleId = useId();
    const t = resolveRollDialogTheme(theme);
    return <div className="fixed inset-0 flex items-center justify-center p-4" style={{ zIndex: layer }}>
        <div className={t.overlay} onClick={onClose} />
        <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}
            className={t.container} style={{ maxHeight: '90dvh', overflowY: 'auto' }}>
            <div className={t.header + (theme?.header ? '' : ' flex justify-between items-center')}>
                <div className="flex min-w-0 flex-col">
                    <h2 id={titleId} className={t.title}>{title}</h2>
                    {subtitle && <p className="text-sm opacity-80">{subtitle}</p>}
                </div>
                <button type="button" onClick={onClose} className={t.closeBtn} aria-label={closeLabel}>
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5" aria-hidden="true">
                        <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                    </svg>
                </button>
            </div>
            <div className={t.body}>{children}</div>
            <div className={t.footer}>{footer}</div>
        </div>
    </div>;
}
