'use client';

import React, { createContext, useCallback, useContext, useMemo, useRef, useState, useEffect } from 'react';
import { logger } from '@shared/utils/logger';
import { ConnectionStep, User } from '@shared/interfaces';
import { useNotifications } from '@client/ui/components/NotificationSystem';
import { useUI } from '@client/ui/context/UIContext';
import * as foundryApi from '@client/ui/api/foundryApi';
import { assertPlayerSurface } from '@client/hooks/useRuntimeSurface';

interface SessionContextType {
    step: ConnectionStep;
    setStep: (step: ConnectionStep, origin?: string, reason?: string) => void;
    token: string | null;
    setToken: (token: string | null) => void;
    users: User[];
    setUsers: React.Dispatch<React.SetStateAction<User[]>>;
    currentUserId: string | null;
    setCurrentUserId: React.Dispatch<React.SetStateAction<string | null>>;
    currentUser: User | null;
    appVersion: string | null;
    setAppVersion: React.Dispatch<React.SetStateAction<string | null>>;
    isConfigured: boolean;
    setIsConfigured: React.Dispatch<React.SetStateAction<boolean>>;
    handleLogin: (username: string, password?: string) => Promise<void>;
    handleLogout: () => Promise<void>;
    invalidateLocalSession: (reason: string) => void;
    isExplicitLogoutPending: () => boolean;
    registerLogoutCleanup: (cleanup: () => void) => () => void;
}

// Compatibility marker for hooks and module UI that currently gate work on
// `token`. It is not a credential and is never sent to the server.
export const COOKIE_SESSION_MARKER = 'cookie-session-active';

const SessionContext = createContext<SessionContextType | undefined>(undefined);

export function SessionProvider({ children }: { children: React.ReactNode }) {
    const { addNotification } = useNotifications();
    const { resetUI } = useUI();

    const [step, setStepState] = useState<ConnectionStep>('init');
    const [token, setTokenState] = useState<string | null>(null);

    const [users, setUsers] = useState<User[]>([]);
    const [currentUserId, setCurrentUserId] = useState<string | null>(null);
    const [appVersion, setAppVersion] = useState<string | null>(null);
    const [isConfigured, setIsConfigured] = useState<boolean>(true);
    const logoutCleanupRef = useRef<Array<() => void>>([]);
    const explicitLogoutPendingRef = useRef(false);

    const currentUser = users.find((user) => (user._id || user.id) === currentUserId) || null;

    // Defensive guard: warn if SessionProvider mounts on non-player surface
    useEffect(() => {
        assertPlayerSurface();
        // Remove credentials persisted by releases before ADR-0033 Phase 2.
        // Cookie restoration happens through /api/status instead.
        window.localStorage.removeItem('sheet-delver-token');
    }, []);

    const setToken = useCallback((newToken: string | null) => {
        setTokenState(newToken);
    }, []);

    const setStep = useCallback((newStep: ConnectionStep, origin: string = 'unknown', reason?: string) => {
        setStepState((previousStep) => {
            if (previousStep === newStep) return previousStep;
            const timestamp = new Date().toISOString();
            logger.debug(`[SessionProvider] ${timestamp} | ${previousStep} -> ${newStep} | Origin: ${origin}${reason ? ` | Reason: ${reason}` : ''}`);
            return newStep;
        });
    }, []);

    const handleLogin = useCallback(async (username: string, password?: string) => {
        try {
            const data = await foundryApi.login(username, password);

            if (!data.success) {
                addNotification('Login failed: ' + data.error, 'error');
                throw new Error(data.error);
            }

            // Login success means the server issued the HttpOnly session cookie.
            setToken(COOKIE_SESSION_MARKER);
            setStep('authenticating', 'handleLogin', 'Login success');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unknown login error';
            addNotification('Error: ' + message, 'error');
            throw error;
        }
    }, [addNotification, setStep, setToken]);

    const invalidateLocalSession = useCallback((reason: string) => {
        // Both explicit logout and server-side revocation must retire every
        // session-bound client cache, not only the non-secret token marker.
        resetUI();
        setStep('login', 'session-invalidation', reason);
        logoutCleanupRef.current.forEach((cleanup) => cleanup());
        setToken(null);
    }, [resetUI, setStep, setToken]);

    const isExplicitLogoutPending = useCallback(
        () => explicitLogoutPendingRef.current,
        [],
    );

    const handleLogout = useCallback(async () => {
        if (explicitLogoutPendingRef.current) return;
        explicitLogoutPendingRef.current = true;

        // Preserve the public-reclassified socket until the server completes
        // Foundry logout. The dedicated step withholds both dashboard and login
        // controls while that socket receives the authoritative inactive roster.
        resetUI();
        setStep('logging-out', 'handleLogout', 'Logout requested');
        logoutCleanupRef.current.forEach((cleanup) => cleanup());
        try {
            await foundryApi.logout(token);
        } catch (error: unknown) {
            logger.error('SessionProvider | Logout error:', error);
        } finally {
            explicitLogoutPendingRef.current = false;
            setToken(null);
            setStep('login', 'handleLogout complete', 'Server logout settled');
        }
    }, [resetUI, setStep, setToken, token]);

    const registerLogoutCleanup = useCallback((cleanup: () => void) => {
        logoutCleanupRef.current.push(cleanup);
        return () => {
            logoutCleanupRef.current = logoutCleanupRef.current.filter((entry) => entry !== cleanup);
        };
    }, []);

    const value = useMemo(() => ({
        step,
        setStep,
        token,
        setToken,
        users,
        setUsers,
        currentUserId,
        setCurrentUserId,
        currentUser,
        appVersion,
        setAppVersion,
        isConfigured,
        setIsConfigured,
        handleLogin,
        handleLogout,
        invalidateLocalSession,
        isExplicitLogoutPending,
        registerLogoutCleanup,
    }), [
        step,
        setStep,
        token,
        setToken,
        users,
        currentUserId,
        currentUser,
        appVersion,
        isConfigured,
        handleLogin,
        handleLogout,
        invalidateLocalSession,
        isExplicitLogoutPending,
        registerLogoutCleanup,
    ]);

    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
    const context = useContext(SessionContext);
    if (!context) {
        throw new Error('useSession must be used within a SessionProvider');
    }
    return context;
}
