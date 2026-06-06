'use client';

import React, { useMemo, useCallback, useEffect } from 'react';
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
import { getClientDocumentSource, resetClientDocumentSource } from '@client/ui/sdk/createClientDocumentSource';
import { createSdkEventBus } from '@client/ui/sdk/createSdkEventBus';
import type { SdkEvents } from '@shared/sdk/events';
import { buildModuleAssetUrl } from '@shared/sdk';

/**
 * SDKProvider bridges the platform's internal contexts and components into
 * the stable SDK surface that external modules consume via useSDK() and
 * useSDKComponents(). Place this above any dynamically-loaded module component.
 *
 * `moduleId` is the surface's resolved module (defaults to the active system id);
 * surfaces that resolve a specific module pass it explicitly (ADR-0027 decision 19).
 */
export function SDKProvider({ children, moduleId }: { children: React.ReactNode; moduleId?: string }) {
    const { token, currentUser, system, worldId, step, appSocket } = useFoundry();
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

    // Host-owned realtime signal bus (ADR-0027 decision 20). Created once (pure — no socket
    // side effects in render, so React re-renders can't desync the binding from subscribers);
    // the socket is bound via attach() from an effect and re-bound when it changes.
    const events = useMemo(() => createSdkEventBus(), []);
    useEffect(() => () => events.dispose(), [events]);
    useEffect(() => {
        events.attach(appSocket as any);
        return () => events.detach();
    }, [events, appSocket]);

    // Host-owned document cache (ADR-0027 decisions 17/25). App-level singleton so a
    // dashboard card and an open sheet share one fetch; the call keeps its transport current.
    const documents = getClientDocumentSource(fetchWithAuth);

    // Cache invalidation rides the signal bus (decision 25): any document:changed for a
    // cached key refreshes every mounted surface from the single source — all types, not
    // just actors.
    useEffect(() => events.on('document:changed', ({ type, id }) => {
        if (id) documents.invalidate(type, id);
    }), [events, documents]);

    // What modules receive is a narrowed `{ on }` facade — the bus's host-only lifecycle
    // methods (`attach` / `detach` / `dispose`) are not present on the object handed across
    // the SDK boundary, so a module can't tear down or rebind the shared realtime bus.
    const eventsPublic = useMemo<SdkEvents>(() => ({
        on: (signal, handler) => events.on(signal, handler),
    }), [events]);

    // Clear the shared cache when the session ends (logout / world change drops the token).
    useEffect(() => {
        if (!token) resetClientDocumentSource();
    }, [token]);

    const resolvedModuleId = moduleId ?? system?.id ?? null;
    const assetUrl = useCallback(
        (assetPath: string) => (resolvedModuleId ? buildModuleAssetUrl(resolvedModuleId, assetPath) : assetPath),
        [resolvedModuleId],
    );

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
        moduleId:       resolvedModuleId,
        worldId:        worldId ?? null,
        documents,
        baseUrl:        typeof window !== 'undefined' ? window.location.origin : '',
        foundryUrl:     foundryUrl ?? '',
        resolveImageUrl,
        assetUrl,
        addNotification,
        isDiceTrayOpen,
        toggleDiceTray,
        isChatOpen,
        setChatOpen,
        fetchWithAuth,
        events: eventsPublic,
        logger,
    }), [
        token, currentUser, system, isConnected,
        resolvedModuleId, worldId, documents,
        foundryUrl, resolveImageUrl, assetUrl, addNotification,
        isDiceTrayOpen, toggleDiceTray, isChatOpen, setChatOpen,
        fetchWithAuth, eventsPublic, logger,
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
