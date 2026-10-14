'use client';

import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useLayoutEffect, ReactNode } from 'react';
import { rememberDismissedShare } from './sharedContentState';
import { createBottomNavigationRegistry } from '../sdk/bottomNavigation';
import type { SharedJournalReceipt } from '@shared/contracts/journals';

interface UIContextType {
    registerBottomNavigation: (element: HTMLElement) => () => void;
    isSettingsOpen: boolean;
    setSettingsOpen: (open: boolean) => void;
    isChatOpen: boolean;
    setChatOpen: (open: boolean) => void;
    isDiceTrayOpen: boolean;
    setDiceTrayOpen: (open: boolean) => void;
    toggleDiceTray: () => void;
    isJournalOpen: boolean;
    setJournalOpen: (open: boolean) => void;
    toggleJournal: () => void;
    isPlayerListOpen: boolean;
    setPlayerListOpen: (open: boolean) => void;
    togglePlayerList: () => void;
    activeJournalId: string | null;
    setActiveJournalId: (id: string | null) => void;
    sharedJournalId: string | null;
    setSharedJournalId: (id: string | null) => void;
    sharedJournalPageId: string | null;
    setSharedJournalPageId: (id: string | null) => void;
    sharedJournalReceipt: SharedJournalReceipt | null;
    setSharedJournalReceipt: (receipt: SharedJournalReceipt | null) => void;
    activeShareKey: string | null;
    setActiveShareKey: (key: string | null) => void;
    dismissedShareKey: string | null;
    dismissSharedContent: () => void;
    resetUI: () => void;
}

const UIContext = createContext<UIContextType | undefined>(undefined);

export function UIProvider({ children }: { children: ReactNode }) {
    const [bottomNavigationInset, setBottomNavigationInset] = useState(0);
    const bottomNavigation = useRef<ReturnType<typeof createBottomNavigationRegistry> | null>(null);
    if (bottomNavigation.current === null) {
        bottomNavigation.current = createBottomNavigationRegistry(setBottomNavigationInset);
    }
    const registerBottomNavigation = useCallback((element: HTMLElement) => bottomNavigation.current!.register(element), []);
    useEffect(() => () => bottomNavigation.current?.clear(), []);
    useLayoutEffect(() => {
        const property = '--sd-bottom-navigation-inset';
        const previous = document.body.style.getPropertyValue(property);
        document.body.style.setProperty(property, `${bottomNavigationInset}px`);
        return () => { if (previous) document.body.style.setProperty(property, previous); else document.body.style.removeProperty(property); };
    }, [bottomNavigationInset]);
    const [isSettingsOpen, setSettingsOpen] = useState(false);
    const [isChatOpen, setChatOpen] = useState(false);
    const [isDiceTrayOpen, setDiceTrayOpen] = useState(false);
    const [isJournalOpen, setJournalOpen] = useState(false);
    const [isPlayerListOpen, setPlayerListOpen] = useState(false);
    const [activeJournalId, setActiveJournalId] = useState<string | null>(null);
    const [sharedJournalId, setSharedJournalId] = useState<string | null>(null);
    const [sharedJournalPageId, setSharedJournalPageId] = useState<string | null>(null);
    const [sharedJournalReceipt, setSharedJournalReceipt] = useState<SharedJournalReceipt | null>(null);
    const [activeShareKey, setActiveShareKey] = useState<string | null>(null);
    const [dismissedShareKey, setDismissedShareKey] = useState<string | null>(null);

    const dismissSharedContent = useCallback(() => {
        if (!activeShareKey) return;
        try { rememberDismissedShare(window.sessionStorage, activeShareKey); } catch { /* Storage may be unavailable. */ }
        setDismissedShareKey(activeShareKey);
        setActiveShareKey(null);
    }, [activeShareKey]);

    const toggleDiceTray = useCallback(() => setDiceTrayOpen(prev => !prev), []);
    const toggleJournal = useCallback(() => setJournalOpen(prev => !prev), []);
    const togglePlayerList = useCallback(() => setPlayerListOpen(prev => !prev), []);

    // Session invalidation depends on this callback; UI changes must not recreate its socket.
    const resetUI = useCallback(() => {
        setSettingsOpen(false);
        setChatOpen(false);
        setDiceTrayOpen(false);
        setJournalOpen(false);
        setPlayerListOpen(false);
        setActiveJournalId(null);
        setSharedJournalId(null);
        setSharedJournalPageId(null);
        setSharedJournalReceipt(null);
        setActiveShareKey(null);
        setDismissedShareKey(null);
        bottomNavigation.current?.clear();
    }, []);

    const contextValue = React.useMemo(() => ({
        registerBottomNavigation,
        isSettingsOpen, setSettingsOpen,
        isChatOpen, setChatOpen,
        isDiceTrayOpen, setDiceTrayOpen, toggleDiceTray,
        isJournalOpen, setJournalOpen, toggleJournal,
        isPlayerListOpen, setPlayerListOpen, togglePlayerList,
        activeJournalId, setActiveJournalId,
        sharedJournalId, setSharedJournalId,
        sharedJournalPageId, setSharedJournalPageId,
        sharedJournalReceipt, setSharedJournalReceipt,
        activeShareKey, setActiveShareKey,
        dismissedShareKey, dismissSharedContent,
        resetUI
    }), [
        registerBottomNavigation,
        isSettingsOpen, isChatOpen, isDiceTrayOpen, isJournalOpen, isPlayerListOpen,
        activeJournalId, sharedJournalId, sharedJournalPageId,
        sharedJournalReceipt, activeShareKey, dismissedShareKey, dismissSharedContent,
        toggleDiceTray, toggleJournal, togglePlayerList, resetUI
    ]);

    return (
        <UIContext.Provider value={contextValue}>
            {children}
        </UIContext.Provider>
    );
}

export function useUI() {
    const context = useContext(UIContext);
    if (!context) {
        throw new Error('useUI must be used within a UIProvider');
    }
    return context;
}
