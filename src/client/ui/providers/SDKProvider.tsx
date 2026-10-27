'use client';

import React, { useMemo, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { SDKContext, SDKComponentsContext, type SDKContextValue } from '@shared/sdk/react';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { useRealtime } from '@client/ui/context/RealtimeContext';
import { useUI } from '@client/ui/context/UIContext';
import { useConfig } from '@client/ui/context/ConfigContext';
import { useNotifications } from '@client/ui/components/NotificationSystem';
import PageHeader from '@client/ui/components/PageHeader';
import LoadingModal from '@client/ui/components/LoadingModal';
import RollDialog from '@client/ui/components/RollDialog';
import { ConfirmationModal } from '@client/ui/components/ConfirmationModal';
import RichTextEditor from '@client/ui/components/RichTextEditor';
import { SharedContentModal } from '@client/ui/components/SharedContentModal';
import {
    getClientDocumentSource,
    refreshObservedClientDocuments,
    setClientDocumentSourceScope,
} from '@client/ui/sdk/createClientDocumentSource';
import { useSDKEvents } from './SDKEventsProvider';
import { buildModuleAssetUrl, setModuleLogSink } from '@shared/sdk';
import { logger as platformLogger } from '@shared/utils/logger';
import { worldRuntimeHeaders } from '@client/ui/api/worldRuntime';

/** Keep module navigation inside the current Sheet Delver origin. */
function resolveInternalNavigationTarget(target: string): string | null {
    if (typeof window === 'undefined' || !target.startsWith('/') || target.startsWith('//')) return null;

    try {
        const resolved = new URL(target, window.location.origin);
        if (resolved.origin !== window.location.origin) return null;
        return `${resolved.pathname}${resolved.search}${resolved.hash}`;
    } catch {
        return null;
    }
}

/**
 * SDKProvider bridges the platform's internal contexts and components into
 * the stable SDK surface that external modules consume via useSDK() and
 * useSDKComponents(). Place this above any dynamically-loaded module component.
 *
 * `moduleId` is the surface's resolved module (defaults to the active system id);
 * surfaces that resolve a specific module pass it explicitly (ADR-0027 decision 19).
 */
export function SDKProvider({ children, moduleId }: { children: React.ReactNode; moduleId?: string }) {
    const router = useRouter();
    const { token, currentUser, system, worldId, step } = useFoundry();
    const { linkState } = useRealtime();
    const { isDiceTrayOpen, toggleDiceTray, isChatOpen, setChatOpen, registerBottomNavigation: registerHostBottomNavigation } = useUI();
    const { foundryUrl, resolveImageUrl } = useConfig();
    const { addNotification, updateNotification, removeNotification } = useNotifications();

    const isConnected = step === 'dashboard' && linkState === 'ready';

    const fetchWithAuth = useCallback(async (
        input: string,
        init?: RequestInit,
    ): Promise<Response> => {
        // Module UI receives the same cookie-authenticated fetch boundary as the
        // host; the compatibility token is never converted into a bearer value.
        const headers = new Headers(init?.headers);
        for (const [key, value] of Object.entries(worldRuntimeHeaders())) headers.set(key, value);
        return fetch(input, { ...init, headers, credentials: 'same-origin' });
    }, []);

    // Page surfaces share the authenticated workspace's event identity and
    // socket subscription. Leaving a tool does not retire module cache listeners.
    const events = useSDKEvents();

    // Host-owned document cache (ADR-0027 decisions 17/25). App-level singleton so a
    // dashboard card and an open sheet share one fetch; the call keeps its transport current.
    const documents = getClientDocumentSource(fetchWithAuth);

    const documentScope = token && worldId && currentUser
        ? JSON.stringify([worldId, currentUser.id ?? (currentUser as any)._id ?? ''])
        : null;

    // Cache invalidation rides the signal bus (decision 25): any document:changed for a
    // cached key refreshes every mounted surface from the single source — all types, not
    // just actors.
    useEffect(() => events.on('document:changed', ({ type, id }) => {
        if (id) documents.invalidate(type, id);
    }), [events, documents]);

    // The SDK cache exists only inside an authenticated world/user scope. The
    // source advances its epoch on scope changes, preserving mounted listeners
    // while rejecting completion from the prior session or world.
    useEffect(() => {
        setClientDocumentSourceScope(documentScope);
    }, [documentScope]);

    useEffect(() => {
        if (isConnected && documentScope) refreshObservedClientDocuments();
    }, [isConnected, documentScope]);

    const resolvedModuleId = moduleId ?? system?.id ?? null;
    // Scope-specific sets keep an old passive cleanup from removing a new
    // module's layout-effect registration during the same React commit.
    const footerScope = JSON.stringify([resolvedModuleId, documentScope]);
    const footerRegistrations = useRef(new Map<string, Set<() => void>>());
    const registerBottomNavigation = useCallback((element: HTMLElement) => {
        const dispose = registerHostBottomNavigation(element);
        const registrations = footerRegistrations.current.get(footerScope) ?? new Set<() => void>();
        footerRegistrations.current.set(footerScope, registrations);
        const release = () => {
            if (!registrations.delete(release)) return;
            dispose();
            if (!registrations.size && footerRegistrations.current.get(footerScope) === registrations) {
                footerRegistrations.current.delete(footerScope);
            }
        };
        registrations.add(release);
        return release;
    }, [registerHostBottomNavigation, footerScope]);
    useEffect(() => {
        const scopes = footerRegistrations.current;
        return () => { for (const release of scopes.get(footerScope) ?? []) release(); };
    }, [footerScope]);
    const assetUrl = useCallback(
        (assetPath: string) => (resolvedModuleId ? buildModuleAssetUrl(resolvedModuleId, assetPath) : assetPath),
        [resolvedModuleId],
    );

    const navigate = useCallback((target: string) => {
        const resolved = resolveInternalNavigationTarget(target);
        if (!resolved) {
            platformLogger.warn(`[SDK] Rejected non-internal navigation target: ${target}`);
            return;
        }
        router.push(resolved);
    }, [router]);

    const replace = useCallback((target: string) => {
        const resolved = resolveInternalNavigationTarget(target);
        if (!resolved) {
            platformLogger.warn(`[SDK] Rejected non-internal replacement target: ${target}`);
            return;
        }
        router.replace(resolved);
    }, [router]);

    const logger = useMemo(() => ({
        debug: (...args: unknown[]) => platformLogger.debug('[module]', ...args),
        info:  (...args: unknown[]) => platformLogger.info('[module]',  ...args),
        warn:  (...args: unknown[]) => platformLogger.warn('[module]',  ...args),
        error: (...args: unknown[]) => platformLogger.error('[module]', ...args),
    }), []);

    // Funnel the shared SDK logger (`import { logger } from '@sheet-delver/sdk'` in module
    // UI/logic, resolved to window.__SD.sdk) through this provider's logger. The SDK is a
    // host singleton on the client, so this binding reaches all module UI code.
    useEffect(() => {
        setModuleLogSink(logger);
        return () => setModuleLogSink(null);
    }, [logger]);

    const sdkValue = useMemo<SDKContextValue>(() => ({
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
        navigate,
        replace,
        addNotification,
        updateNotification,
        removeNotification,
        isDiceTrayOpen,
        toggleDiceTray,
        isChatOpen,
        setChatOpen,
        registerBottomNavigation,
        fetchWithAuth,
        events,
        logger,
    }), [
        token, currentUser, system, isConnected,
        resolvedModuleId, worldId, documents,
        foundryUrl, resolveImageUrl, assetUrl, navigate, replace, addNotification,
        updateNotification, removeNotification,
        isDiceTrayOpen, toggleDiceTray, isChatOpen, setChatOpen,
        registerBottomNavigation,
        fetchWithAuth, events, logger,
    ]);

    // Components are stable references — useMemo avoids recreating the object
    // on every render while keeping the actual components as singletons.
    const components = useMemo(() => ({
        LoadingModal,
        RollDialog,
        ConfirmationModal,
        RichTextEditor,
        SharedContentModal,
        PageHeader,
    }), []);

    return (
        <SDKContext.Provider value={sdkValue}>
            <SDKComponentsContext.Provider value={components}>
                {children}
            </SDKComponentsContext.Provider>
        </SDKContext.Provider>
    );
}
