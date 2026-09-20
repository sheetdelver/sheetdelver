'use client';

import { createContext, useContext, useEffect, useCallback, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { EMPTY_NOTIFICATIONS, NotificationStore } from './notificationStore';
import { NotificationContainer } from './NotificationContainer';
import { feedbackClearance } from './feedbackLayout';

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

const FeedbackAnchorContext = createContext<(element: HTMLElement) => () => void>(() => () => {});

// Optional for standalone compatibility trays; registration never enters the SDK contract.
export function useDiceTrayFeedbackAnchor() {
    const register = useContext(FeedbackAnchorContext);
    return useCallback((element: HTMLDivElement | null) => element ? register(element) : undefined, [register]);
}

export function NotificationProvider({ children }: { children: ReactNode }) {
    const value = useNotificationValue();
    const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
    const [anchors, setAnchors] = useState<HTMLElement[]>([]);
    const [clearance, setClearance] = useState<ReturnType<typeof feedbackClearance>>(null);
    const registerAnchor = useCallback((element: HTMLElement) => {
        setAnchors(current => [...current, element]);
        return () => setAnchors(current => current.filter(anchor => anchor !== element));
    }, []);
    useLayoutEffect(() => {
        const measure = () => {
            const next = feedbackClearance(window.innerHeight, anchors.map(anchor => {
                const rect = anchor.getBoundingClientRect();
                // Reserve the full panel height even while its opening transform is scaled.
                return { top: Math.min(rect.top, rect.bottom - anchor.offsetHeight), bottom: rect.bottom, height: rect.height };
            }));
            setClearance(previous => previous?.bottom === next?.bottom && previous?.maxHeight === next?.maxHeight ? previous : next);
        };
        measure();
        const observer = new ResizeObserver(measure);
        anchors.forEach(anchor => {
            observer.observe(anchor);
            anchor.addEventListener('transitionend', measure);
        });
        window.addEventListener('resize', measure);
        return () => {
            observer.disconnect();
            anchors.forEach(anchor => anchor.removeEventListener('transitionend', measure));
            window.removeEventListener('resize', measure);
        };
    }, [anchors]);
    return <FeedbackAnchorContext.Provider value={registerAnchor}><NotificationContext.Provider value={{ ...value, viewport }}>
        {children}
        <div ref={setViewport} aria-label="Live feedback" className="fixed right-4 z-[200] pointer-events-none flex flex-col gap-2 overflow-y-auto"
            style={{
                bottom: clearance ? `max(calc(6rem + env(safe-area-inset-bottom)), ${clearance.bottom}px)` : 'calc(6rem + env(safe-area-inset-bottom))',
                width: 'min(420px, calc(100vw - 32px))',
                maxHeight: clearance ? `min(calc(100dvh - 7rem), ${clearance.maxHeight}px)` : 'calc(100dvh - 7rem)',
            }}>
            <NotificationContainer {...value} />
        </div>
    </NotificationContext.Provider></FeedbackAnchorContext.Provider>;
}

export function useNotifications() {
    const value = useContext(NotificationContext);
    if (!value) throw new Error('useNotifications must be used within a NotificationProvider');
    return value;
}
