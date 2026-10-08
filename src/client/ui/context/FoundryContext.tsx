'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { logger } from '@shared/utils/logger';
import { AppSystemInfo, User, ConnectionStep } from '@shared/interfaces';
import type { ActorCardData, UIModuleManifest } from '@shared/sdk';
import { Socket } from 'socket.io-client';
import { useSession } from '@client/ui/context/SessionContext';
import { useActorCombat } from '@client/ui/context/ActorCombatContext';
import { useRealtime } from '@client/ui/context/RealtimeContext';
import { useChat } from '@client/ui/context/ChatContext';
import { UnauthorizedApiError } from '@client/ui/api/http';
import * as foundryApi from '@client/ui/api/foundryApi';
import { useActorRealtime } from '@client/ui/hooks/useActorRealtime';
import { useCombatRealtime } from '@client/ui/hooks/useCombatRealtime';
import { applyModulePresentation } from './modulePresentation';
import { useModuleHotReload } from '@client/ui/hooks/useModuleHotReload';
import { useSharedContentRealtime } from '@client/ui/hooks/useSharedContentRealtime';
import { useSystemStatusRealtime } from '@client/ui/hooks/useSystemStatusRealtime';
import { resetClientDocumentSource } from '@client/ui/sdk/createClientDocumentSource';
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
        invalidateLocalSession,
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
        isExplicitLogoutPending,
        registerLogoutCleanup,
    } = useSession();

    const { appSocket, linkState } = useRealtime();

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

    const { messages, handleChatSend, fetchChat, resetChatState } = useChat();

    const [system, setSystem] = useState<AppSystemInfo | null>(null);
    const [sharedContent, setSharedContent] = useState<RealtimeSharedContentPayload | null>(null);
    const [lastWorldId, setLastWorldId] = useState<string | null>(null);
    const activeUIModule = useModuleHotReload({ appSocket, systemId: system?.id });

    useEffect(() => {
        const unregister = registerLogoutCleanup(() => {
            setCurrentUserId(null);
            setUsers([]);
            resetActorCombatState();
            resetChatState();
            resetClientDocumentSource();
            setSharedContent(null);
        });
        return unregister;
    }, [registerLogoutCleanup, resetActorCombatState, resetChatState, setCurrentUserId, setUsers]);

    useEffect(() => {
        if (step !== 'world-closed' && step !== 'setup') return;
        // A definitive close retires the mounted world view, but the cookie
        // and retained user identity remain available for same-world restore.
        // Clear document projections without treating a close as a 401.
        resetActorCombatState();
        resetChatState();
        resetClientDocumentSource();
        setSharedContent(null);
    }, [step, resetActorCombatState, resetChatState]);

    // The socket's initial status seeds world/configuration state. The
    // protected read in RealtimeProvider, never public /api/status, decides
    // whether the browser cookie is an authorized player session.
    useEffect(() => {
        if (!token || linkState !== 'ready' || step !== 'dashboard') return;
        let current = true;
        void foundryApi.fetchSharedContent(token).then((data) => {
            if (current) setSharedContent(data);
        }).catch((error) => {
            if (!current) return;
            if (error instanceof UnauthorizedApiError) {
                invalidateLocalSession('shared-content-401');
            } else {
                logger.debug('FoundryProvider | Shared content temporarily unavailable:', error);
            }
        });
        return () => { current = false; };
    }, [token, linkState, step, invalidateLocalSession]);

    useEffect(() => {
        if (!token || linkState !== 'ready' || step !== 'dashboard') return;
        // A reconnect can miss document/list broadcasts. Re-read authorized
        // state rather than trusting the retained pre-outage snapshots.
        void fetchActors();
        void fetchCombats();
        void fetchChat();
    }, [token, linkState, step, fetchActors, fetchCombats, fetchChat]);

    useSystemStatusRealtime({
        appSocket,
        step,
        token,
        linkState,
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
        invalidateLocalSession,
        setSharedContent,
        setLastWorldId,
        resetActorCombatState,
        fetchActors,
        isExplicitLogoutPending,
    });
    useSharedContentRealtime({ appSocket, sharedContent, setSharedContent });
    useActorRealtime({ appSocket, token, actorCards, patchActorCard, fetchActors });
    useUserRosterRealtime({ appSocket, token, users, setUsers });
    useCombatRealtime({ appSocket, step, token, fetchCombats });

    const presentedSystem = React.useMemo(() => applyModulePresentation(system, activeUIModule), [system, activeUIModule]);

    const contextValue = React.useMemo(() => ({
        step, setStep,
        token, setToken,
        users, currentUser,
        system: presentedSystem, worldId: lastWorldId, messages,
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
        step, setStep, token, users, currentUser, presentedSystem, lastWorldId, messages,
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
