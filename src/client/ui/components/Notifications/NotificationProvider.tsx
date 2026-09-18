'use client';

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { EMPTY_NOTIFICATIONS, NotificationStore } from './notificationStore';
import { NotificationContainer } from './NotificationContainer';

function useNotificationValue() {
    const [store] = useState(() => new NotificationStore());
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY_NOTIFICATIONS);
    useEffect(() => {
        const visibility = () => store.setHidden(document.visibilityState !== 'visible');
        visibility();
        document.addEventListener('visibilitychange', visibility);
        return () => {
            document.removeEventListener('visibilitychange', visibility);
            store.clear();
        };
    }, [store]);
    const api = useMemo(() => ({
        addNotification: store.add, updateNotification: store.update,
        removeNotification: store.remove, clearNotifications: store.clear,
        pauseNotification: store.pause,
    }), [store]);
    return useMemo(() => ({ ...api, ...snapshot }), [api, snapshot]);
}

const NotificationContext = createContext<(ReturnType<typeof useNotificationValue> & { viewport: HTMLDivElement | null }) | null>(null);

export function NotificationProvider({ children }: { children: ReactNode }) {
    const value = useNotificationValue();
    const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
    return <NotificationContext.Provider value={{ ...value, viewport }}>
        {children}
        <div ref={setViewport} aria-label="Live feedback" className="fixed right-4 z-[200] pointer-events-none flex flex-col gap-2 overflow-y-auto"
            style={{ bottom: 'calc(6rem + env(safe-area-inset-bottom))', width: 'min(420px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 7rem)' }}>
            <NotificationContainer {...value} />
        </div>
    </NotificationContext.Provider>;
}

export function useNotifications() {
    const value = useContext(NotificationContext);
    if (!value) throw new Error('useNotifications must be used within a NotificationProvider');
    return value;
}
