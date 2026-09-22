'use client';

import { createContext, useContext, useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import type { NotificationAPI } from '@shared/sdk/notifications';
import { useNotifications } from '@client/ui/components/NotificationSystem';
import { useAdminAuth } from './AdminAuthContext';
import { useAdminRuntimeRestart } from './AdminRuntimeRestartContext';
import { scopeAdminNotifications } from '../lib/adminNotifications';

const Context = createContext<NotificationAPI | null>(null);

/** Admin lifecycle only; queue, rendering and timers belong to the shared provider. */
export function AdminNotificationProvider({ children }: { children: ReactNode }) {
    const { addNotification, updateNotification, removeNotification, clearNotifications } = useNotifications();
    const { isAuthenticated, sessionRevision, isCurrentSession } = useAdminAuth();
    const { restarting, isRuntimeRestarting } = useAdminRuntimeRestart();
    const mounted = useRef(false);

    useLayoutEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; clearNotifications(); };
    }, [clearNotifications]);
    useLayoutEffect(() => { clearNotifications(); }, [sessionRevision, restarting, clearNotifications]);

    const isCurrent = useCallback(() => mounted.current && isAuthenticated && !restarting
        && isCurrentSession(sessionRevision) && !isRuntimeRestarting(),
    [isAuthenticated, restarting, sessionRevision, isCurrentSession, isRuntimeRestarting]);
    const actions = useMemo(() => scopeAdminNotifications(
        // The factory stores this guard; it only reads refs when an action is invoked.
        // eslint-disable-next-line react-hooks/refs
        { addNotification, updateNotification, removeNotification }, isCurrent,
    ), [addNotification, updateNotification, removeNotification, isCurrent]);

    return <Context.Provider value={actions}>{children}</Context.Provider>;
}

export function useAdminNotifications() {
    const value = useContext(Context);
    if (!value) throw new Error('useAdminNotifications must be used within AdminNotificationProvider');
    return value;
}
