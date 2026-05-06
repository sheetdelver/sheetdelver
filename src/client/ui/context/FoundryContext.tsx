'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode, useRef } from 'react';
import { logger } from '@shared/utils/logger';
import { AppSystemInfo, User, ConnectionStep } from '@shared/interfaces';
import type { ActorCardData, UIModuleManifest } from '@shared/sdk';
import { getUIModule } from '@modules/registry/client';
import { Socket } from 'socket.io-client';
import { useSession } from '@client/ui/context/SessionContext';
import { useActorCombat } from '@client/ui/context/ActorCombatContext';
import { useRealtime } from '@client/ui/context/RealtimeContext';
import { useChat } from '@client/ui/context/ChatContext';
import { UnauthorizedApiError } from '@client/ui/api/http';
import * as foundryApi from '@client/ui/api/foundryApi';
import type { AuthenticatedStatusPayload, SystemStatusPayload } from '@shared/contracts/status';
import type { ActorDto, ActorListPayload, ActorCardsPayload } from '@shared/contracts/actors';
import type { CombatDto, CombatListPayload } from '@shared/contracts/combats';
import type { ChatMessageDto } from '@shared/contracts/chat';
import type {
    RealtimeSharedContentPayload,
    RealtimeCombatUpdatePayload,
} from '@shared/contracts/realtime';

interface FoundryContextType {
    step: ConnectionStep;
    setStep: (step: ConnectionStep) => void;
    token: string | null;
    setToken: (token: string | null) => void;
    users: User[];
    currentUser: User | null;
    system: AppSystemInfo | null;
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
    combats: CombatDto[];
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
    const [activeUIModule, setActiveUIModule] = useState<UIModuleManifest | null>(null);
    const [sharedContent, setSharedContent] = useState<RealtimeSharedContentPayload | null>(null);
    const [lastWorldId, setLastWorldId] = useState<string | null>(null);

    // Ref so socket handlers always see the latest actorCards without being in the dep array
    const actorCardsRef = useRef(actorCards);
    useEffect(() => { actorCardsRef.current = actorCards; }, [actorCards]);

    const isEqual = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

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

        const initStatus = async () => {
            try {
                // Fetch initial status to seed specific user data like currentUserId
                const data = await foundryApi.fetchStatus(token);
                if (!isMounted) return;

                if (data.currentUserId) setCurrentUserId(data.currentUserId);
                if (data.isConfigured !== undefined) setIsConfigured(data.isConfigured);

                // Fetch initial shared content
                if (token) {
                    const scData = await foundryApi.fetchSharedContent(token);
                    setSharedContent(scData);
                }
            } catch (e) {
                if (e instanceof UnauthorizedApiError) {
                    setToken(null);
                    return;
                }
                logger.error('FoundryProvider | Initial status fetch failed', e);
            }
        };

        initStatus();

        return () => {
            isMounted = false;
        };
    }, [token, setCurrentUserId, setIsConfigured, setToken]);

    // --- Real-time Socket Status Sync ---
    useEffect(() => {
        if (!appSocket) return;

        const determineStep = (data: SystemStatusPayload, currentStep: string, configured: boolean) => {
            const status = data.system?.status || (data.connected ? 'active' : 'offline');
            const isAuthenticated = !!token;

            if (!configured) return 'setup';
            const worldTitle = data.system?.worldTitle;

            // Priority 1: Explicit System States (Setup/Offline/Startup/Closed)
            if (status === 'closed') return 'world-closed';
            if (status === 'setup') return 'world-closed';
            if (status === 'offline') {
                // If we discovered a world title during the probe, we are in 'startup'
                // If not, we are still 'initializing' or waiting for the server to wake up.
                // Critical: Do NOT jump to 'setup' here based on uncertainty.
                return worldTitle ? 'startup' : 'initializing';
            }
            if (status === 'startup') return 'startup';

            // Priority 2: Backend Initialization (Wait until Cache + Discovery is ready)
            if (!data.connected || data.initialized === false) {
                // Return 'startup' if we have world information, otherwise indicate 'initialization'
                return worldTitle ? 'startup' : 'initializing';
            }

            if (currentStep === 'authenticating') {
                return isAuthenticated ? 'dashboard' : 'authenticating';
            }

            if (!worldTitle) return 'startup';

            // If connected and active, but no token, we must be at login
            return isAuthenticated ? 'dashboard' : 'login';
        };

        const handleSystemStatus = (data: SystemStatusPayload) => {
            try {
                if (data.debug?.level !== undefined) {
                    logger.setLevel(data.debug.level);
                }

                if (data.url && typeof window !== 'undefined') {
                    const { setFoundryUrl, foundryUrl } = (window as any)._sd_config_actions || {};
                    if (setFoundryUrl && foundryUrl !== data.url) setFoundryUrl(data.url);
                }

                // Treat both active and offline as valid payloads for determining step
                if (data.system) {
                    const currentWorldId = data.worldId || null;
                    if (data.connected && lastWorldId && currentWorldId && lastWorldId !== currentWorldId) {
                        logger.warn(`FoundryProvider | World changed from "${lastWorldId}" to "${currentWorldId}". Purging state.`);
                        
                        // Aggressive state purge to prevent cross-world contamination
                        if (token) setToken(null);
                        resetActorCombatState();
                        setUsers([]);
                        setSharedContent(null);
                        
                        setLastWorldId(currentWorldId);
                    } else if (data.connected && currentWorldId && !lastWorldId) {
                        setLastWorldId(currentWorldId);
                    }

                    // Allow system data to update from probe data even when not fully connected.
                    // This ensures world title/description appear in the 'world-closed' state.
                    if (!isEqual(system, data.system)) setSystem(data.system);
                    if (data.connected && !isEqual(users, data.users)) setUsers((data.users || []) as User[]);
                    if (data.appVersion && appVersion !== data.appVersion) setAppVersion(data.appVersion);
                    if (data.isConfigured !== undefined && isConfigured !== data.isConfigured) setIsConfigured(data.isConfigured);

                    const targetStep = determineStep(data, step, isConfigured) as ConnectionStep;
                    if (step !== targetStep) {
                        setStep(targetStep, 'socket', `Status change: ${targetStep}`);
                        if (targetStep === 'dashboard' && data.connected) fetchActors();
                    }
                }
            } catch (e) {
                logger.error('FoundryProvider | Error handling system status:', e);
            }
        };

        const handleSharedContentUpdate = (scData: RealtimeSharedContentPayload) => {
            if (!isEqual(sharedContent, scData)) setSharedContent(scData);
        };

        const handleActorUpdate = async (data: { actorId?: string }) => {
            if (!data.actorId || !token) return;
            try {
                const card = await foundryApi.fetchActorCardById(token, data.actorId);
                if (!card) return;
                const isNew = !actorCardsRef.current[data.actorId];
                patchActorCard(data.actorId, card);
                // New actor — refresh the full list so it appears on the dashboard
                if (isNew) fetchActors();
            } catch {
                // Actor deleted or access revoked — refresh the full list
                fetchActors();
            }
        };

        appSocket.on('systemStatus', handleSystemStatus);
        appSocket.on('sharedContentUpdate', handleSharedContentUpdate);
        appSocket.on('actorUpdate', handleActorUpdate);

        return () => {
            appSocket.off('systemStatus', handleSystemStatus);
            appSocket.off('sharedContentUpdate', handleSharedContentUpdate);
            appSocket.off('actorUpdate', handleActorUpdate);
        };
    }, [appSocket, step, token, system, users, appVersion, sharedContent, fetchActors, patchActorCard, resetActorCombatState, setAppVersion, setIsConfigured, setStep, setToken, setUsers, lastWorldId, isConfigured]);

    // Hydrate activeAdapter and activeUIModule when system changes
    useEffect(() => {
        let isMounted = true;
        async function hydrateUI() {
            if (system?.id) {
                const uiManifest = await getUIModule(system.id);
                if (isMounted) {
                    setActiveUIModule(uiManifest || null);
                }
            } else {
                if (isMounted) {
                    setActiveUIModule(null);
                }
            }
        }
        hydrateUI();
        return () => { isMounted = false; };
    }, [system?.id]);

    // Combat real-time sync
    useEffect(() => {
        if (step === 'dashboard' && token) {
            fetchCombats(); // Initial fetch

            if (appSocket) {
                const handleCombatUpdate = (data: RealtimeCombatUpdatePayload) => {
                    //logger.debug('FoundryContext | Socket Combat Update received:', data);
                    fetchCombats();
                };

                appSocket.on('combatUpdate', handleCombatUpdate);

                return () => {
                    appSocket.off('combatUpdate', handleCombatUpdate);
                };
            }
        }
    }, [step, token, fetchCombats, appSocket]);

    const contextValue = React.useMemo(() => ({
        step, setStep,
        token, setToken,
        users, currentUser,
        system, messages,
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
        step, setStep, token, users, currentUser, system, messages,
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
