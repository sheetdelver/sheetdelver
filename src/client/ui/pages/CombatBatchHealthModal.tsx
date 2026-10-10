'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CombatManagerHealthBatchRequest } from '@shared/contracts/combatManager';

interface Props {
    targets: CombatManagerHealthBatchRequest['targets'] | null;
    names: string[];
    busy: boolean;
    onClose: () => void;
    onApply: (operation: 'damage' | 'heal', amount: number) => void;
}

export function CombatBatchHealthModal({ targets, names, busy, onClose, onApply }: Props) {
    const [mounted, setMounted] = useState(false);
    const [amount, setAmount] = useState('');
    useEffect(() => { setMounted(true); return () => setMounted(false); }, []);
    useEffect(() => { setAmount(''); }, [targets]);
    useEffect(() => {
        if (!targets) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
        window.addEventListener('keydown', escape);
        return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', escape); };
    }, [targets, busy, onClose]);
    if (!mounted || !targets) return null;
    const valid = amount.trim() !== '' && Number.isFinite(Number(amount)) && Number(amount) > 0
        && Number(amount) <= 1_000_000_000;
    return createPortal(<div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
        <div className="sd-ui-overlay absolute inset-0 backdrop-blur-md" onClick={() => { if (!busy) onClose(); }} />
        <section role="dialog" aria-modal="true" aria-labelledby="combat-batch-health-title"
            className="sd-ui-modal sd-ui-panel-raised relative z-10 w-full max-w-md rounded-2xl p-6 shadow-2xl backdrop-blur-xl">
            <div className="sd-ui-divider mb-4 flex items-start justify-between gap-3 border-b pb-3">
                <div>
                    <h3 id="combat-batch-health-title" className="text-xl font-bold">Damage or heal {targets.length} participants</h3>
                    <p className="sd-ui-muted mt-1 text-xs">{names.join(', ')}</p>
                </div>
                <button aria-label="Close batch health controls" disabled={busy} onClick={onClose}
                    className="sd-ui-button px-2 py-1 text-sm">✕</button>
            </div>
            <label htmlFor="combat-batch-health-amount" className="block text-sm">Amount</label>
            <div className="mt-2 flex items-center gap-2">
                <button disabled={busy || !valid} onClick={() => onApply('heal', Number(amount))}
                    className="sd-ui-button px-3 py-2 text-sm font-semibold">Heal all</button>
                <input id="combat-batch-health-amount" type="number" min="0" step="any" value={amount}
                    onChange={event => setAmount(event.target.value)} disabled={busy}
                    className="sd-ui-control min-w-0 flex-1 px-3 py-2 text-center" />
                <button disabled={busy || !valid} onClick={() => onApply('damage', Number(amount))}
                    className="sd-ui-button sd-ui-button-danger px-3 py-2 text-sm font-semibold">Damage all</button>
            </div>
            <p className="sd-ui-muted mt-3 text-xs">All values are checked before changes begin. A write failure may leave earlier changes in place.
                No damage rules or maximum-health cap are applied.</p>
        </section>
    </div>, document.body);
}
