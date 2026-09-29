'use client';

import { createContext, useCallback, useContext, useLayoutEffect, useState, type ReactNode } from 'react';

export type PlayerAppearance = 'dark' | 'light';

export const PLAYER_APPEARANCE_KEY = 'sheetdelver-player-appearance';

const PlayerAppearanceContext = createContext<{
    appearance: PlayerAppearance;
    setAppearance: (appearance: PlayerAppearance) => void;
} | null>(null);

export function readPlayerAppearance(storage: Pick<Storage, 'getItem'>): PlayerAppearance {
    try {
        return storage.getItem(PLAYER_APPEARANCE_KEY) === 'light' ? 'light' : 'dark';
    } catch {
        return 'dark';
    }
}

export function PlayerAppearanceProvider({ children }: { children: ReactNode }) {
    const [appearance, setAppearanceState] = useState<PlayerAppearance>('dark');

    useLayoutEffect(() => {
        setAppearanceState(readPlayerAppearance(window.localStorage));
        const onStorage = (event: StorageEvent) => {
            if (event.key === PLAYER_APPEARANCE_KEY || event.key === null) {
                setAppearanceState(readPlayerAppearance(window.localStorage));
            }
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    useLayoutEffect(() => {
        document.body.dataset.sdAppearance = appearance;
        document.documentElement.dataset.sdAppearance = appearance;
        return () => {
            delete document.body.dataset.sdAppearance;
            delete document.documentElement.dataset.sdAppearance;
        };
    }, [appearance]);

    const setAppearance = useCallback((next: PlayerAppearance) => {
        setAppearanceState(next);
        try { window.localStorage.setItem(PLAYER_APPEARANCE_KEY, next); } catch { /* Keep this tab usable without storage. */ }
    }, []);

    return (
        <PlayerAppearanceContext.Provider value={{ appearance, setAppearance }}>
            <div className="sd-player-root" data-sd-appearance={appearance}>{children}</div>
        </PlayerAppearanceContext.Provider>
    );
}

export function usePlayerAppearance() {
    const context = useContext(PlayerAppearanceContext);
    if (!context) throw new Error('usePlayerAppearance must be used inside PlayerAppearanceProvider');
    return context;
}
