'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import type { CombatListPayload } from '@shared/contracts/combats';
import type { ConnectionStep } from '@shared/interfaces';

interface UseCombatRealtimeOptions {
    appSocket: Socket | null;
    step: ConnectionStep;
    token: string | null;
    fetchCombats: () => Promise<CombatListPayload | void>;
}

export function useCombatRealtime({
    appSocket,
    step,
    token,
    fetchCombats,
}: UseCombatRealtimeOptions) {
    const combatRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const requestCombatRefresh = useCallback(() => {
        if (combatRefreshTimerRef.current) clearTimeout(combatRefreshTimerRef.current);
        combatRefreshTimerRef.current = setTimeout(() => {
            combatRefreshTimerRef.current = null;
            void fetchCombats();
        }, 75);
    }, [fetchCombats]);

    useEffect(() => () => {
        if (combatRefreshTimerRef.current) {
            clearTimeout(combatRefreshTimerRef.current);
            combatRefreshTimerRef.current = null;
        }
    }, []);

    useEffect(() => {
        if (step !== 'dashboard' || !token) return;

        void fetchCombats();
        if (!appSocket) return;

        const handleCombatChanged = () => { requestCombatRefresh(); };
        const handleCombatListInvalidated = () => { requestCombatRefresh(); };

        appSocket.on('combatChanged', handleCombatChanged);
        appSocket.on('combatListInvalidated', handleCombatListInvalidated);

        return () => {
            appSocket.off('combatChanged', handleCombatChanged);
            appSocket.off('combatListInvalidated', handleCombatListInvalidated);
        };
    }, [appSocket, fetchCombats, requestCombatRefresh, step, token]);
}
