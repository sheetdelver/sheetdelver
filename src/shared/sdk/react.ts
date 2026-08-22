import { createContext, useContext } from 'react';
import type { ComponentType } from 'react';
import type { RealtimeActorChangedPayload } from './contracts';
import type { ClientDocumentSource } from './client-documents';
import type { SdkEvents } from './events';

// ---------------------------------------------------------------------------
// Logger — client-side, for use in module UI components
// ---------------------------------------------------------------------------

export interface ModuleClientLogger {
    debug: (...args: unknown[]) => void;
    info:  (...args: unknown[]) => void;
    warn:  (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
}

// ---------------------------------------------------------------------------
// SDK context value — provided to all module components at runtime
// ---------------------------------------------------------------------------

export interface SDKContextValue {
    // Auth / identity
    /** @deprecated Non-secret session-readiness marker; use fetchWithAuth for requests. */
    token: string | null;
    currentUser: { id: string; name: string; isGM: boolean; role: number } | null;
    system: { id: string | null; title?: string; version?: string } | null;
    isConnected: boolean;

    // Host-provided runtime identity (ADR-0027 decision 19). Supplied by the host at
    // each surface rather than discovered by modules via `/system/data`.
    moduleId: string | null;
    worldId: string | null;

    // Host-owned document cache + data API (ADR-0027 decisions 17/25). The only
    // module-facing data surface; consumed by useDocument / useDocumentMutation / useActorSheet.
    documents: ClientDocumentSource;

    // URL resolution
    baseUrl: string;
    foundryUrl: string;
    resolveImageUrl: (path: string) => string;
    /** Resolve a module static asset to its platform URL (ADR-0027 decision 27). */
    assetUrl: (assetPath: string) => string;

    // Notifications
    addNotification: (
        message: string,
        type?: 'info' | 'success' | 'error',
        options?: { html?: boolean },
    ) => void;

    // Global UI state
    isDiceTrayOpen: boolean;
    toggleDiceTray: () => void;
    isChatOpen: boolean;
    setChatOpen: (open: boolean) => void;

    // Authenticated fetch for platform REST APIs (/api/actors/[id], etc.)
    fetchWithAuth: (input: string, init?: RequestInit) => Promise<Response>;

    // Realtime signal bus (ADR-0027 decision 20) — `events.on(signal, handler)`.
    // Replaces the actor-only `onActorChanged`; covers all document types + lifecycle.
    events: SdkEvents;

    // Client logger — prefixed with [module] in the browser console
    logger: ModuleClientLogger;
}

// ---------------------------------------------------------------------------
// SDK components value — platform UI components injected at runtime
//
// Components are typed as ComponentType<any> because their internal prop
// interfaces exceed the stable surface documented in @sheet-delver/sdk.
// Use the *Props interfaces exported from this package for documentation.
// ---------------------------------------------------------------------------

export interface SDKComponentsValue {
    LoadingModal: ComponentType<any>;
    RollDialog: ComponentType<any>;
    ConfirmationModal: ComponentType<any>;
    RichTextEditor: ComponentType<any>;
    SharedContentModal: ComponentType<any>;
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

export const SDKContext = createContext<SDKContextValue | null>(null);
export const SDKComponentsContext = createContext<SDKComponentsValue | null>(null);

// ---------------------------------------------------------------------------
// Hooks — import from '@sheet-delver/sdk'
// ---------------------------------------------------------------------------

export function useSDK(): SDKContextValue {
    const ctx = useContext(SDKContext);
    if (!ctx) {
        throw new Error('useSDK() must be called inside a module component rendered by the platform');
    }
    return ctx;
}

export function useSDKComponents(): SDKComponentsValue {
    const ctx = useContext(SDKComponentsContext);
    if (!ctx) {
        throw new Error('useSDKComponents() must be called inside a module component rendered by the platform');
    }
    return ctx;
}

// Re-export so callers can import RealtimeActorChangedPayload from '@sheet-delver/sdk'
export type { RealtimeActorChangedPayload };
