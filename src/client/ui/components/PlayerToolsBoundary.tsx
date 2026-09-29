'use client';

import { useEffect, type ReactNode } from 'react';
import { useSession } from '../context/SessionContext';
import { useUI } from '../context/UIContext';

/** Suspend world tools while session/world readiness is being resolved. */
export function PlayerToolsBoundary({ children }: { children: ReactNode }) {
    const { step, token } = useSession();
    const { resetUI } = useUI();
    const available = step === 'dashboard' && Boolean(token);

    useEffect(() => {
        if (!available) resetUI();
    }, [available, resetUI]);

    // Only the presentation is retired. Session and realtime providers stay
    // mounted so an eligible session can recover through the normal flow.
    return available ? children : null;
}
