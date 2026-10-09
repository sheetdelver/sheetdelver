'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export interface CombatBeginChoice {
    combatId: string;
    activeOtherCount: number;
    unrolledPlayers: number;
    unrolledNpcs: number;
    unavailablePlayers: number;
    unavailableNpcs: number;
}

interface Props {
    prompt: CombatBeginChoice | null;
    busy: boolean;
    onChoose: (choice: 'npc' | 'all' | 'anyway') => void;
    onCancel: () => void;
}

export function CombatBeginModal({ prompt, busy, onChoose, onCancel }: Props) {
    const [mounted, setMounted] = useState(false);
    useEffect(() => { setMounted(true); return () => setMounted(false); }, []);
    useEffect(() => {
        if (!prompt) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onCancel(); };
        window.addEventListener('keydown', escape);
        return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', escape); };
    }, [prompt, busy, onCancel]);
    if (!mounted || !prompt) return null;
    const availableNpcs = prompt.unrolledNpcs - prompt.unavailableNpcs;
    const availableAll = availableNpcs + prompt.unrolledPlayers - prompt.unavailablePlayers;
    const unavailable = prompt.unavailableNpcs + prompt.unavailablePlayers;
    return createPortal(<div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
        <div className="sd-ui-overlay absolute inset-0 backdrop-blur-md" onClick={() => { if (!busy) onCancel(); }} />
        <section role="dialog" aria-modal="true" aria-labelledby="combat-begin-title"
            className="sd-ui-modal sd-ui-panel-raised relative z-10 w-full max-w-lg rounded-2xl p-6 shadow-2xl backdrop-blur-xl">
            <h3 id="combat-begin-title" className="sd-ui-accent text-xl font-bold">Begin encounter</h3>
            <p className="mt-3 text-sm">Unrolled: {prompt.unrolledPlayers} player-owned, {prompt.unrolledNpcs} NPCs.</p>
            {unavailable > 0 && <p className="sd-ui-danger mt-2 text-sm">{unavailable} cannot roll with the current formula and will remain unrolled. Enter their initiative manually if needed.</p>}
            {prompt.activeOtherCount > 0 && <p className="sd-ui-danger mt-2 text-sm">
                {prompt.activeOtherCount} other {prompt.activeOtherCount === 1 ? 'Combat is' : 'Combats are'} active in Foundry.
                Beginning here will deactivate {prompt.activeOtherCount === 1 ? 'it' : 'them'}, including scene encounters.
            </p>}
            <div className="mt-5 flex flex-wrap gap-2">
                <button disabled={busy || availableNpcs === 0} onClick={() => onChoose('npc')}
                    className="sd-ui-button px-3 py-2 text-sm font-semibold">
                    Roll {prompt.unavailableNpcs ? 'available NPCs' : 'NPCs'} and begin ({availableNpcs})
                </button>
                <button disabled={busy || availableAll === 0} onClick={() => onChoose('all')}
                    className="sd-ui-button px-3 py-2 text-sm font-semibold">
                    Roll {unavailable ? 'available' : 'all'} and begin ({availableAll})
                </button>
                <button disabled={busy} onClick={() => onChoose('anyway')}
                    className="sd-ui-button sd-ui-button-primary px-3 py-2 text-sm font-semibold">Begin anyway</button>
                <button disabled={busy} onClick={onCancel} className="sd-ui-button px-3 py-2 text-sm">Cancel</button>
            </div>
        </section>
    </div>, document.body);
}
