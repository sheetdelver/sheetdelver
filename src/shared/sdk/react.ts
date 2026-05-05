import { createContext, useContext } from 'react';
import type { ComponentType } from 'react';
import type { RealtimeActorUpdatePayload } from './contracts';

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
    token: string | null;
    currentUser: { id: string; name: string; isGM: boolean; role: number } | null;
    system: { id: string | null; title?: string; version?: string } | null;
    isConnected: boolean;

    // URL resolution
    baseUrl: string;
    foundryUrl: string;
    resolveImageUrl: (path: string) => string;

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

    // Realtime — subscribe to actor update events for a specific actor
    // Returns a cleanup function; call it in useEffect cleanup.
    onActorUpdate: (
        actorId: string,
        callback: (data: RealtimeActorUpdatePayload) => void,
    ) => () => void;

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

// Re-export so callers can import RealtimeActorUpdatePayload from '@sheet-delver/sdk'
export type { RealtimeActorUpdatePayload };
