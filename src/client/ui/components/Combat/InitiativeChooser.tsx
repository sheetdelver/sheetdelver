'use client';

import { useEffect, useRef } from 'react';
import type { CombatTrackerCombatantDto } from '@shared/contracts/combats';
import RollDialogFrame from '../RollDialogFrame';
import { useModalFocus } from '@client/ui/hooks/useModalFocus';
import type { InitiativeOutcome } from './initiativeSequence';

export default function InitiativeChooser({ rows, currentRows, outcomes, busy, started, onIndividual, onAll, onClose }: {
    rows: CombatTrackerCombatantDto[];
    currentRows: CombatTrackerCombatantDto[];
    outcomes: InitiativeOutcome[];
    busy: boolean;
    started: boolean;
    onIndividual: (row: CombatTrackerCombatantDto) => void;
    onAll: () => void;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useModalFocus(ref, true, onClose);
    // Starting removes the individual/All controls. Keep focus inside the
    // dialog so Escape and the focus trap remain available during the batch.
    useEffect(() => { if (started) ref.current?.focus(); }, [started]);
    const button = 'sd-ui-button min-h-11 rounded-lg px-3 py-2 text-sm font-semibold';
    const currentById = new Map(currentRows.map(row => [row.id, row]));
    const outcomeById = new Map(outcomes.map(outcome => [outcome.id, outcome]));
    return <RollDialogFrame title="Roll initiative" dialogRef={ref} layer={210} onClose={onClose}
        footer={<>
            {!started && <button type="button" className={`${button} sd-ui-button-primary`} disabled={busy}
                onClick={onAll}>Roll all</button>}
            <button type="button" className={button} onClick={onClose}>{busy ? 'Stop remaining rolls' : 'Close'}</button>
        </>}>
        <p className="sd-ui-muted text-sm">Roll all uses each character’s default formula. Use individual Roll for manual input or advantage choices.</p>
        <ol className="space-y-3" aria-label="Your initiative rolls" aria-live="polite">
            {rows.map(row => {
                const candidate = currentById.get(row.id);
                const current = candidate?.actorId === row.actorId ? candidate : undefined;
                const outcome = outcomeById.get(row.id);
                return <li key={row.id} className="sd-ui-inset rounded-lg p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 break-words font-semibold">{current?.name || 'Participant unavailable'}</span>
                        {!started && <button type="button" className={button} disabled={busy || !current?.canRollInitiative}
                            onClick={() => current && onIndividual(current)}>Roll {current?.name || 'character'}</button>}
                    </div>
                    <p className="sd-ui-muted break-words text-sm">{outcome?.state ?? 'unattempted'}{outcome?.message ? ` · ${outcome.message}` : ''}</p>
                </li>;
            })}
        </ol>
        {started && !busy && <p className="sd-ui-muted text-sm">Refresh the tracker and inspect chat before starting any further rolls.</p>}
    </RollDialogFrame>;
}
