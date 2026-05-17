'use client';

import React, { useMemo, useCallback } from 'react';
import { SDKContext, SDKComponentsContext } from '@shared/sdk/react';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { useUI } from '@client/ui/context/UIContext';
import { useConfig } from '@client/ui/context/ConfigContext';
import { useNotifications } from '@client/ui/components/NotificationSystem';
import LoadingModal from '@client/ui/components/LoadingModal';
import RollDialog from '@client/ui/components/RollDialog';
import { ConfirmationModal } from '@client/ui/components/ConfirmationModal';
import RichTextEditor from '@client/ui/components/RichTextEditor';
import { SharedContentModal } from '@client/ui/components/SharedContentModal';
import type { RealtimeActorChangedPayload } from '@shared/sdk/contracts';

/**
 * SDKProvider bridges the platform's internal contexts and components into
 * the stable SDK surface that external modules consume via useSDK() and
 * useSDKComponents(). Place this above any dynamically-loaded module component.
 */
export function SDKProvider({ children }: { children: React.ReactNode }) {
    const { token, currentUser, system, step, appSocket } = useFoundry();
    const { isDiceTrayOpen, toggleDiceTray, isChatOpen, setChatOpen } = useUI();
    const { foundryUrl, resolveImageUrl } = useConfig();
    const { addNotification: addToast } = useNotifications();

    const isConnected = step === 'dashboard';

    const addNotification = useCallback((
        message: string,
        type: 'info' | 'success' | 'error' = 'info',
        options?: { html?: boolean },
    ) => addToast(message, type, options), [addToast]);

    const fetchWithAuth = useCallback(async (
        input: string,
        init?: RequestInit,
    ): Promise<Response> => {
        const headers = new Headers(init?.headers);
        if (token) headers.set('Authorization', `Bearer ${token}`);
        return fetch(input, { ...init, headers });
    }, [token]);

    const onActorChanged = useCallback((
        actorId: string,
        callback: (data: RealtimeActorChangedPayload) => void,
    ) => {
        const socket = appSocket as any;
        if (!socket) return () => {};
        const handler = (data: RealtimeActorChangedPayload) => {
            if (data.actorId === actorId) callback(data);
        };
        socket.on('actorChanged', handler);
        return () => { socket.off('actorChanged', handler); };
    }, [appSocket]);

    const logger = useMemo(() => ({
        debug: (...args: unknown[]) => console.debug('[module]', ...args),
        info:  (...args: unknown[]) => console.info('[module]',  ...args),
        warn:  (...args: unknown[]) => console.warn('[module]',  ...args),
        error: (...args: unknown[]) => console.error('[module]', ...args),
    }), []);

    const sdkValue = useMemo(() => ({
        token,
        currentUser: currentUser
            ? {
                id:    currentUser.id ?? (currentUser as any)._id ?? '',
                name:  currentUser.name,
                isGM:  currentUser.isGM  ?? false,
                role:  currentUser.role  ?? 0,
            }
            : null,
        system: system
            ? { id: system.id, title: system.title, version: system.version }
            : null,
        isConnected,
        baseUrl:        typeof window !== 'undefined' ? window.location.origin : '',
        foundryUrl:     foundryUrl ?? '',
        resolveImageUrl,
        addNotification,
        isDiceTrayOpen,
        toggleDiceTray,
        isChatOpen,
        setChatOpen,
        fetchWithAuth,
        onActorChanged,
        logger,
    }), [
        token, currentUser, system, isConnected,
        foundryUrl, resolveImageUrl, addNotification,
        isDiceTrayOpen, toggleDiceTray, isChatOpen, setChatOpen,
        fetchWithAuth, onActorChanged, logger,
    ]);

    // Components are stable references — useMemo avoids recreating the object
    // on every render while keeping the actual components as singletons.
    const components = useMemo(() => ({
        LoadingModal,
        RollDialog,
        ConfirmationModal,
        RichTextEditor,
        SharedContentModal,
    }), []);

    return (
        <SDKContext.Provider value={sdkValue}>
            <SDKComponentsContext.Provider value={components}>
                {children}
            </SDKComponentsContext.Provider>
        </SDKContext.Provider>
    );
}
