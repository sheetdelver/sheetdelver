'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { logger } from '@shared/utils/logger';
import { AppSystemInfo, User, ConnectionStep } from '@shared/interfaces';
import type { ActorCardData, UIModuleManifest } from '@shared/sdk';
import { Socket } from 'socket.io-client';
import { COOKIE_SESSION_MARKER, useSession } from '@client/ui/context/SessionContext';
import { useActorCombat } from '@client/ui/context/ActorCombatContext';
import { useRealtime } from '@client/ui/context/RealtimeContext';
import { useChat } from '@client/ui/context/ChatContext';
import { UnauthorizedApiError } from '@client/ui/api/http';
import {
    getStatusBootstrapRetryDelayMs,
    isStatusBootstrapUnavailable,
    shouldDiscardWorldSession,
} from '@client/ui/context/foundryStatusBootstrap';
import * as foundryApi from '@client/ui/api/foundryApi';
import { useActorRealtime } from '@client/ui/hooks/useActorRealtime';
import { useCombatRealtime } from '@client/ui/hooks/useCombatRealtime';
import { useModuleHotReload } from '@client/ui/hooks/useModuleHotReload';
import { useSharedContentRealtime } from '@client/ui/hooks/useSharedContentRealtime';
import { useSystemStatusRealtime } from '@client/ui/hooks/useSystemStatusRealtime';
import { useUserRosterRealtime } from '@client/ui/hooks/useUserRosterRealtime';
import type { ActorDto, ActorListPayload, ActorCardsPayload } from '@shared/contracts/actors';
import type { CombatTrackerDto, CombatListPayload } from '@shared/contracts/combats';
import type { ChatMessageDto } from '@shared/contracts/chat';
import type {
    RealtimeSharedContentPayload,
} from '@shared/contracts/realtime';

interface FoundryContextType {
    step: ConnectionStep;
    setStep: (step: ConnectionStep) => void;
    token: string | null;
    setToken: (token: string | null) => void;
    users: User[];
    currentUser: User | null;
    system: AppSystemInfo | null;
    /** Active world identifier (from StatusService); null until a world is connected. */
    worldId: string | null;
    messages: ChatMessageDto[];
    appVersion: string | null;
    activeUIModule: UIModuleManifest | null;
    actorCards: Record<string, ActorCardData>;
    fetchActorCards: () => Promise<ActorCardsPayload | void>;
    isConfigured: boolean;

    // Actions
    handleLogin: (username: string, password?: string) => Promise<void>;
    handleChatSend: (message: string, options?: { rollMode?: string, speaker?: string }) => Promise<void>;
    handleLogout: () => Promise<void>;
    fetchActors: () => Promise<ActorListPayload | void>;

    // Actors (Shared state)
    ownedActors: ActorDto[];
    readOnlyActors: ActorDto[];
    sharedContent: RealtimeSharedContentPayload | null;

    // Combats
    combats: CombatTrackerDto[];
    fetchCombats: () => Promise<CombatListPayload | void>;

    // Real-time
    appSocket: Socket | null;
}

const FoundryContext = createContext<FoundryContextType | undefined>(undefined);

export function FoundryProvider({ children }: { children: ReactNode }) {
    const {
        step,
        setStep,
        token,
        setToken,
        users,
        setUsers,
        currentUser,
        setCurrentUserId,
        appVersion,
        setAppVersion,
        isConfigured,
        setIsConfigured,
        handleLogin,
        handleLogout,
        registerLogoutCleanup,
    } = useSession();

    const { appSocket } = useRealtime();

    const {
        ownedActors,
        readOnlyActors,
        actorCards,
        combats,
        fetchActorCards,
        fetchActors,
        fetchCombats,
        patchActorCard,
        resetActorCombatState,
    } = useActorCombat();

    const { messages, handleChatSend, resetChatState } = useChat();

    const [system, setSystem] = useState<AppSystemInfo | null>(null);
    const [sharedContent, setSharedContent] = useState<RealtimeSharedContentPayload | null>(null);
    const [lastWorldId, setLastWorldId] = useState<string | null>(null);
    const activeUIModule = useModuleHotReload({ appSocket, systemId: system?.id });

    useEffect(() => {
        const unregister = registerLogoutCleanup(() => {
            setCurrentUserId(null);
            resetActorCombatState();
            resetChatState();
            setSharedContent(null);
        });
        return unregister;
    }, [registerLogoutCleanup, resetActorCombatState, resetChatState, setCurrentUserId]);

    // --- Initial Status Bootstrap ---
    useEffect(() => {
        let isMounted = true;
        let retryTimeout: ReturnType<typeof setTimeout> | null = null;
        let resolveRetryWait: (() => void) | null = null;

        const waitForRetry = (attempt: number) => new Promise<void>((resolve) => {
            resolveRetryWait = resolve;
            retryTimeout = setTimeout(() => {
                retryTimeout = null;
                resolveRetryWait = null;
                resolve();
            }, getStatusBootstrapRetryDelayMs(attempt));
        });

        const fetchInitialStatus = async () => {
            let retryAttempt = 0;

            while (isMounted) {
                try {
                    const data = await foundryApi.fetchStatus(token);
                    if (!isMounted) return;

                    if (retryAttempt > 0) {
                        logger.info('FoundryProvider | Initial status fetch recovered');
                    }
                    return data;
                } catch (e) {
                    if (!isMounted) return;

                    if (e instanceof UnauthorizedApiError) {
                        setToken(null);
                        return undefined;
                    }

                    // Retry only the public status read across a temporary Core
                    // start/reload boundary; protected reads are handled later.
                    if (isStatusBootstrapUnavailable(e)) {
                        if (retryAttempt === 0) {
                            logger.warn('FoundryProvider | Core service unavailable; retrying initial status fetch');
                        }
                        await waitForRetry(retryAttempt);
                        retryAttempt += 1;
                        continue;
                    }

                    logger.error('FoundryProvider | Initial status fetch failed', e);
                    return undefined;
                }
            }
        };

        const initStatus = async () => {
            // Seed identity/configuration only after the retryable public read succeeds.
            const data = await fetchInitialStatus();
            if (!isMounted || !data) return;

            // A valid HttpOnly cookie is discovered through status; JavaScript
            // retains only a non-secret readiness marker for existing hooks.
            if (data.isAuthenticated === true && !token) {
                setToken(COOKIE_SESSION_MARKER);
            } else if (data.isAuthenticated === false && token) {
                setToken(null);
            }

            if (token && shouldDiscardWorldSession(data)) {
                logger.info('FoundryProvider | Discarding stale world session in terminal lifecycle state');
                setCurrentUserId(null);
                setSharedContent(null);
                setToken(null);
                return;
            }

            if (data.currentUserId) setCurrentUserId(data.currentUserId);
            if (data.isConfigured !== undefined) setIsConfigured(data.isConfigured);

            // A protected bootstrap read is valid only after status confirms that
            // this token restored. Its readiness failure must not restart status.
            if (data.isAuthenticated === true) {
                try {
                    const scData = await foundryApi.fetchSharedContent(COOKIE_SESSION_MARKER);
                    if (!isMounted) return;
                    setSharedContent(scData);
                } catch (e) {
                    if (!isMounted) return;
                    if (e instanceof UnauthorizedApiError) {
                        setToken(null);
                    } else if (isStatusBootstrapUnavailable(e)) {
                        logger.warn('FoundryProvider | Initial shared content unavailable while world is not ready');
                    } else {
                        logger.error('FoundryProvider | Initial shared content fetch failed', e);
                    }
                }
            }
        };

        initStatus();

        return () => {
            isMounted = false;
            if (retryTimeout) clearTimeout(retryTimeout);
            retryTimeout = null;
            // Release a pending wait so the retired effect can observe isMounted.
            resolveRetryWait?.();
            resolveRetryWait = null;
        };
    }, [token, setCurrentUserId, setIsConfigured, setToken]);

    useSystemStatusRealtime({
        appSocket,
        step,
        token,
        system,
        users,
        appVersion,
        isConfigured,
        lastWorldId,
        setSystem,
        setUsers,
        setAppVersion,
        setIsConfigured,
        setStep,
        setToken,
        setSharedContent,
        setLastWorldId,
        resetActorCombatState,
        fetchActors,
    });
    useSharedContentRealtime({ appSocket, sharedContent, setSharedContent });
    useActorRealtime({ appSocket, token, actorCards, patchActorCard, fetchActors });
    useUserRosterRealtime({ appSocket, token, users, setUsers });
    useCombatRealtime({ appSocket, step, token, fetchCombats });

    const contextValue = React.useMemo(() => ({
        step, setStep,
        token, setToken,
        users, currentUser,
        system, worldId: lastWorldId, messages,
        appVersion,
        activeUIModule,
        actorCards,
        fetchActorCards,
        isConfigured,
        handleLogin, handleChatSend, handleLogout, fetchActors,
        ownedActors, readOnlyActors,
        sharedContent,
        combats, fetchCombats,
        appSocket
    }), [
        step, setStep, token, users, currentUser, system, lastWorldId, messages,
        appVersion, activeUIModule, actorCards, ownedActors, readOnlyActors,
        sharedContent, combats, appSocket, isConfigured,
        fetchActorCards, handleLogin, handleChatSend, handleLogout, fetchActors, fetchCombats, setToken
    ]);

    return (
        <FoundryContext.Provider value={contextValue}>
            {children}
        </FoundryContext.Provider>
    );
}

export function useFoundry() {
    const context = useContext(FoundryContext);
    if (!context) {
        throw new Error('useFoundry must be used within a FoundryProvider');
    }
    return context;
}
