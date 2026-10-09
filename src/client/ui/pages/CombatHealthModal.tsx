'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export interface CombatHealthTarget {
    combatantId: string;
    actorId: string;
    name: string;
    label: string;
    key: string;
    path: string;
    current: number;
    max?: number;
}

interface Props {
    target: CombatHealthTarget | null;
    busy: boolean;
    conflict: boolean;
    observedCurrent?: number;
    onClose: () => void;
    onApply: (target: CombatHealthTarget, value: number, retry: boolean) => void;
}

export function CombatHealthModal({ target, busy, conflict, observedCurrent, onClose, onApply }: Props) {
    const [mounted, setMounted] = useState(false);
    const [currentDraft, setCurrentDraft] = useState('');
    const [amount, setAmount] = useState('');
    const [pending, setPending] = useState<{ kind: 'current' } | { kind: 'amount'; sign: 1 | -1 } | null>(null);

    useEffect(() => { setMounted(true); return () => setMounted(false); }, []);
    useEffect(() => {
        setCurrentDraft(target ? String(target.current) : '');
        setAmount('');
        setPending(null);
    }, [target]);
    useEffect(() => {
        if (!target) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !busy) onClose();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', onKeyDown); };
    }, [target, busy, onClose]);

    if (!mounted || !target) return null;
    const validCurrent = currentDraft.trim() !== '' && Number.isFinite(Number(currentDraft));
    const validAmount = currentDraft === String(target.current) && amount.trim() !== ''
        && Number.isFinite(Number(amount)) && Number(amount) > 0;
    const commitCurrent = () => {
        if (!busy && !conflict && validCurrent && Number(currentDraft) !== target.current) {
            setPending({ kind: 'current' });
            onApply(target, Number(currentDraft), false);
        }
    };
    const applyAmount = (sign: 1 | -1) => {
        if (!busy && !conflict && validAmount) {
            setPending({ kind: 'amount', sign });
            onApply(target, target.current + sign * Number(amount), false);
        }
    };

    return createPortal(<div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
        <div className="sd-ui-overlay absolute inset-0 backdrop-blur-md" onClick={() => { if (!busy) onClose(); }} />
        <section role="dialog" aria-modal="true" aria-labelledby="combat-health-title"
            className="sd-ui-modal sd-ui-panel-raised relative z-10 w-full max-w-sm rounded-2xl p-6 shadow-2xl backdrop-blur-xl">
            <div className="sd-ui-divider mb-4 flex items-start justify-between gap-3 border-b pb-3">
                <div>
                    <h3 id="combat-health-title" className="text-xl font-bold">{target.name}</h3>
                    <p className="sd-ui-muted text-sm">{target.label} · {observedCurrent ?? target.current} / {target.max ?? '—'}</p>
                </div>
                <button aria-label="Close health controls" disabled={busy} onClick={onClose}
                    className="sd-ui-button px-2 py-1 text-sm">✕</button>
            </div>
            <label className="block text-sm">Current {target.label}
                <input type="number" aria-label={`Current ${target.label}`} value={currentDraft}
                    onChange={event => setCurrentDraft(event.target.value)} onBlur={commitCurrent}
                    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                    disabled={busy} className="sd-ui-control mt-1 w-full px-3 py-2" />
            </label>
            <p className="sd-ui-muted mt-1 text-xs">Changing the current value applies when you leave the field.</p>
            {conflict && <p className="sd-ui-danger mt-2 text-xs" role="alert">
                This value changed to {observedCurrent ?? 'an unavailable value'} while you were editing. Your draft is still here.
                {pending && observedCurrent !== undefined && (pending.kind === 'amount'
                    ? amount.trim() !== '' && Number.isFinite(Number(amount)) && Number(amount) > 0 : validCurrent)
                    && <button disabled={busy} className="ml-2 underline"
                    onClick={() => onApply(target, pending.kind === 'current' ? Number(currentDraft)
                        : observedCurrent + pending.sign * Number(amount), true)}>Retry with new value</button>}
            </p>}
            <div className="sd-ui-divider mt-5 border-t pt-4">
                <label htmlFor="combat-health-amount" className="block text-sm">Amount</label>
                <div className="mt-2 flex items-center gap-2">
                    <button disabled={busy || conflict || !validAmount} onMouseDown={event => event.preventDefault()} onClick={() => applyAmount(1)}
                        className="sd-ui-button px-3 py-2 text-sm font-semibold">Heal</button>
                    <input id="combat-health-amount" type="number" min="0" step="any" value={amount}
                        onChange={event => setAmount(event.target.value)} disabled={busy}
                        className="sd-ui-control min-w-0 flex-1 px-3 py-2 text-center" />
                    <button disabled={busy || conflict || !validAmount} onMouseDown={event => event.preventDefault()} onClick={() => applyAmount(-1)}
                        className="sd-ui-button sd-ui-button-danger px-3 py-2 text-sm font-semibold">Damage</button>
                </div>
                <p className="sd-ui-muted mt-2 text-xs">Applies simple arithmetic; no system-specific damage or healing rules.</p>
            </div>
        </section>
    </div>, document.body);
}
