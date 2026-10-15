'use client';

import { useEffect, useRef, useState } from 'react';
import type { InitiativeRollModalProps } from '@shared/sdk/ui';
import { applyInitiativeMode } from '@shared/contracts/initiativeMode';
import RollDialogFrame, { resolveRollDialogTheme } from './RollDialogFrame';

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
    const t = resolveRollDialogTheme(theme);
    return <RollDialogFrame title={title} subtitle={combatantName} theme={theme}
        onClose={onClose} dialogRef={dialogRef} layer={210} closeLabel="Close initiative dialog"
        footer={<div className="flex flex-col gap-3">
            {manualAvailable && <button type="button" aria-expanded={manual}
                className="sd-ui-button w-full py-2 px-4 font-bold text-xs uppercase tracking-widest"
                onClick={() => setManual(value => !value)}>Input Manually</button>}
            {manual && manualAvailable ? <>
                <div className={t.inputGroup}>
                    <label className={t.label} htmlFor="initiative-manual-total">Final initiative total</label>
                    <input id="initiative-manual-total" className={t.input} type="number" step="any"
                        value={total} onChange={event => setTotal(event.target.value)} />
                </div>
                <button type="button" disabled={!canSubmitManual} className={`${t.rollBtn('normal')} disabled:opacity-50`}
                    onClick={() => onConfirm({ kind: 'manual', total: numeric })}>Submit total</button>
            </> : <>
                {rollAvailable && <button type="button" className={t.rollBtn('normal')}
                    onClick={() => onConfirm({ kind: 'roll' })}>Roll initiative</button>}
                {rollAvailable && advantageAvailable && <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
                    <button type="button" className={t.rollBtn('adv')} title={applyInitiativeMode(formula, 'advantage')}
                        onClick={() => onConfirm({ kind: 'roll', advantageMode: 'advantage' })}>Advantage</button>
                    <button type="button" className={t.rollBtn('dis')} title={applyInitiativeMode(formula, 'disadvantage')}
                        onClick={() => onConfirm({ kind: 'roll', advantageMode: 'disadvantage' })}>Disadvantage</button>
                </div>}
            </>}
        </div>}>
        <div className={t.inputGroup}>
            <span className={t.label}>Formula</span>
            <code className={`${t.input} break-words`} aria-label="Initiative formula">{formula || 'Unavailable'}</code>
        </div>
        <div className={t.inputGroup}>
            <span className={t.label}>Mode</span>
            <span className={t.input}>{audience === 'gm' ? 'Private GM Roll' : 'Public Roll'}</span>
        </div>
        <p className="text-xs opacity-70">Source: {source === 'gm' ? 'GM override' : source === 'module' ? 'System module' : 'Core fallback'}</p>
    </RollDialogFrame>;
}
