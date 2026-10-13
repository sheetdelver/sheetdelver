'use client';

import { useEffect, useRef, useState } from 'react';
import type { InitiativeRollModalProps } from '@shared/sdk/ui';
import { applyInitiativeMode } from '@shared/contracts/initiativeMode';

/** Shared Core initiative presentation; no formula edits or transport access. */
export default function InitiativeRollDialog({ isOpen, title, combatantName, formula, source,
    rollAvailable, advantageAvailable, manualAvailable, audience, onConfirm, onClose,
    theme }: InitiativeRollModalProps) {
    const [manual, setManual] = useState(false);
    const [total, setTotal] = useState('');
    const dialogRef = useRef<HTMLDivElement>(null);
    const priorFocus = useRef<HTMLElement | null>(null);
    const onCloseRef = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

    useEffect(() => {
        if (!isOpen) return;
        priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setManual(!rollAvailable);
        setTotal('');
        dialogRef.current?.querySelector('button')?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onCloseRef.current();
            if (event.key !== 'Tab' || !dialogRef.current) return;
            const controls = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        };
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('keydown', onKey); priorFocus.current?.focus(); };
    }, [isOpen, rollAvailable]);

    if (!isOpen) return null;
    const numeric = total.trim() ? Number(total) : Number.NaN;
    const canSubmitManual = manualAvailable && Number.isFinite(numeric);
    const buttonBase = 'min-h-11 rounded-xl px-4 py-2 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2';
    const button = `sd-ui-button ${buttonBase}`;
    const rollButton = (mode: 'normal' | 'adv' | 'dis') => theme?.rollBtn
        ? `${buttonBase} ${theme.rollBtn(mode)}` : `${button} ${mode === 'normal' ? 'sd-ui-button-primary' : ''}`;
    // A complete module skin owns its surface colors; the unlayered Core panel
    // rule would otherwise override scoped Tailwind theme utilities.
    const themedSurface = Boolean(theme?.container && theme?.body);
    return <div className="fixed inset-0 z-[210] flex items-center justify-center p-4" role="presentation">
        <div className={`sd-ui-overlay absolute inset-0 ${theme?.overlay ?? ''}`} onClick={onClose} />
        <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="initiative-dialog-title"
            className={`${themedSurface ? '' : 'sd-ui-panel-raised'} relative max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-2xl shadow-2xl ${theme?.body ? '' : 'p-5'} ${theme?.container ?? ''}`}
            style={{ overflowY: 'auto' }}>
            <div className={`flex items-start justify-between gap-3 ${theme?.header ?? ''}`}>
                <div>
                    <h2 id="initiative-dialog-title" className={`text-xl font-bold ${theme?.title ?? ''}`}>{title}</h2>
                    <p className={`${theme?.header ? 'opacity-80' : 'sd-ui-muted'} text-sm`}>{combatantName}</p>
                </div>
                <button type="button" onClick={onClose} aria-label="Close initiative dialog"
                    className={theme?.closeBtn ? `${buttonBase} ${theme.closeBtn}` : button}>Close</button>
            </div>
            <div className={theme?.body ?? ''}>
                <div className="sd-ui-inset mt-4 rounded-xl p-3 text-sm">
                    <p>Formula: <code>{formula || 'Unavailable'}</code></p>
                    <p className="sd-ui-muted mt-1">Source: {source === 'gm' ? 'GM setting' : source === 'module' ? 'System module' : 'Core fallback'} · Audience: {audience === 'gm' ? 'GMs' : 'Public'}</p>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                    {rollAvailable && <button type="button" className={rollButton('normal')} onClick={() => onConfirm({ kind: 'roll' })}>Roll initiative</button>}
                    {rollAvailable && advantageAvailable && <>
                        <button type="button" className={rollButton('adv')} onClick={() => onConfirm({ kind: 'roll', advantageMode: 'advantage' })}>
                            Advantage <code>{applyInitiativeMode(formula, 'advantage')}</code></button>
                        <button type="button" className={rollButton('dis')} onClick={() => onConfirm({ kind: 'roll', advantageMode: 'disadvantage' })}>
                            Disadvantage <code>{applyInitiativeMode(formula, 'disadvantage')}</code></button>
                    </>}
                    {manualAvailable && <button type="button" className={button} aria-expanded={manual} onClick={() => setManual(value => !value)}>Manual total</button>}
                </div>
                {manual && manualAvailable && <div className="mt-4 flex flex-wrap items-end gap-2">
                    <label className="flex-1 text-sm font-semibold" htmlFor="initiative-manual-total">Final initiative total
                        <input id="initiative-manual-total" className={`${theme?.input ?? 'sd-ui-control'} mt-1 w-full rounded-lg p-2`} type="number" step="any"
                            value={total} onChange={event => setTotal(event.target.value)} />
                    </label>
                    <button type="button" disabled={!canSubmitManual} className={`${rollButton('normal')} disabled:opacity-50`}
                        onClick={() => onConfirm({ kind: 'manual', total: numeric })}>Submit total</button>
                </div>}
            </div>
        </div>
    </div>;
}
