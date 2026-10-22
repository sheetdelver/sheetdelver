'use client';

import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import RollDialogFrame from '@client/ui/components/RollDialogFrame';
import { useModalFocus } from '@client/ui/hooks/useModalFocus';

/** Shared dialog frame and focus handling, with Core's encounter theme. */
export function CombatManagerDialog({ title, busy, compact = false, onClose, children }: {
    title: string; busy: boolean; compact?: boolean; onClose: () => void; children: ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const close = () => { if (!busy) onClose(); };
    useModalFocus(ref, true, close);
    return createPortal(<RollDialogFrame title={title} dialogRef={ref} onClose={close}
        theme={{ container: `sd-ui-modal sd-ui-panel-raised relative z-10 w-full ${compact ? 'max-w-xl' : 'max-w-4xl'} rounded-xl p-4 font-sans shadow-2xl md:p-6`,
            title: 'sd-ui-accent text-2xl font-bold', body: 'space-y-4 mb-4' }}
        footer={<button type="button" disabled={busy} onClick={close}
            className="sd-ui-button self-end px-4 py-2 text-sm font-semibold">Close</button>}>
        {children}
    </RollDialogFrame>, document.body);
}
