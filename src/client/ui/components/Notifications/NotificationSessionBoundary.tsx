'use client';

import { useEffect, useRef } from 'react';
import { useFoundry } from '../../context/FoundryContext';
import { useSession } from '../../context/SessionContext';
import { useRealtime } from '../../context/RealtimeContext';
import { useChat } from '../../context/ChatContext';
import { useNotifications } from './NotificationProvider';

/** Keep the provider usable on login while retiring notices from a previous world/user. */
export function NotificationSessionBoundary() {
    const { token, step, currentUserId, registerLogoutCleanup } = useSession();
    const { worldId } = useFoundry();
    const { appSocket } = useRealtime();
    const { clearNotifications } = useNotifications();
    const { resetChatState, fetchChat } = useChat();
    const scope = token && step === 'dashboard' ? JSON.stringify([worldId, currentUserId]) : null;
    const previous = useRef(scope);
    useEffect(() => {
        if (previous.current !== scope) {
            clearNotifications();
            if (previous.current !== null) {
                resetChatState();
                if (scope) void fetchChat();
            }
        }
        previous.current = scope;
    }, [scope, clearNotifications, resetChatState, fetchChat]);
    useEffect(() => registerLogoutCleanup(clearNotifications), [registerLogoutCleanup, clearNotifications]);
    useEffect(() => {
        appSocket?.on('disconnect', clearNotifications);
        appSocket?.on('serverRestarting', clearNotifications);
        return () => {
            appSocket?.off('disconnect', clearNotifications);
            appSocket?.off('serverRestarting', clearNotifications);
        };
    }, [appSocket, clearNotifications]);
    return null;
}
