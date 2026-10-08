'use client';

import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { logger } from '@shared/utils/logger';
import type { Socket } from 'socket.io-client';
import type { ActorListPayload } from '@shared/contracts/actors';
import type { RealtimeStatusPayload } from '@shared/contracts/status';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';
import type { AppSystemInfo, ConnectionStep, User } from '@shared/interfaces';
import { determineConnectionStep } from '@client/ui/context/foundryConnectionStep';
import {
    areSystemInfoEqual,
    areUsersEqual,
} from '@client/ui/context/foundryRealtimeComparisons';

interface UseSystemStatusRealtimeOptions {
    appSocket: Socket | null;
    step: ConnectionStep;
    token: string | null;
    linkState: 'connecting' | 'checking' | 'ready' | 'guest' | 'disconnected' | 'unavailable';
    system: AppSystemInfo | null;
    users: User[];
    appVersion: string | null;
    isConfigured: boolean;
    lastWorldId: string | null;
    setSystem: (system: AppSystemInfo | null) => void;
    setUsers: Dispatch<SetStateAction<User[]>>;
    setAppVersion: Dispatch<SetStateAction<string | null>>;
    setIsConfigured: Dispatch<SetStateAction<boolean>>;
    setStep: (step: ConnectionStep, origin?: string, reason?: string) => void;
    invalidateLocalSession: (reason: string) => void;
    setSharedContent: Dispatch<SetStateAction<RealtimeSharedContentPayload | null>>;
    setLastWorldId: Dispatch<SetStateAction<string | null>>;
    resetActorCombatState: () => void;
    fetchActors: () => Promise<ActorListPayload | void>;
    isExplicitLogoutPending: () => boolean;
}

export function useSystemStatusRealtime({
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
}: UseSystemStatusRealtimeOptions) {
    const latestRef = useRef({
        step,
        token,
        linkState,
        system,
        users,
        appVersion,
        isConfigured,
        lastWorldId,
        fetchActors,
    });

    useEffect(() => {
        latestRef.current = {
            step,
            token,
            linkState,
            system,
            users,
            appVersion,
            isConfigured,
            lastWorldId,
            fetchActors,
        };
    }, [appVersion, fetchActors, isConfigured, lastWorldId, linkState, step, system, token, users]);

    useEffect(() => {
        if (!appSocket) return;

        const handleSystemStatus = (data: RealtimeStatusPayload) => {
            try {
                if (data.debug?.level !== undefined) {
                    logger.setLevel(data.debug.level);
                }

                if (data.url && typeof window !== 'undefined') {
                    const { setFoundryUrl, foundryUrl } = (window as any)._sd_config_actions || {};
                    if (setFoundryUrl && foundryUrl !== data.url) setFoundryUrl(data.url);
                }

                if (!data.system) return;

                const latest = latestRef.current;
                const currentWorldId = data.worldId || null;
                const enteredSetup =
                    data.system.status === 'setup' &&
                    latest.system?.status !== 'setup';

                if (enteredSetup) {
                    logger.info('FoundryProvider | World entered setup. Purging world-bound client state.');
                    if (latest.token) invalidateLocalSession('world-entered-setup');
                    resetActorCombatState();
                    setUsers([]);
                    setSharedContent(null);
                    setLastWorldId(null);
                } else if (
                    data.connected &&
                    latest.lastWorldId &&
                    currentWorldId &&
                    latest.lastWorldId !== currentWorldId
                ) {
                    logger.warn(`FoundryProvider | World changed from "${latest.lastWorldId}" to "${currentWorldId}". Purging state.`);

                    if (latest.token) invalidateLocalSession('world-changed');
                    resetActorCombatState();
                    setUsers([]);
                    setSharedContent(null);

                    setLastWorldId(currentWorldId);
                } else if (data.connected && currentWorldId && !latest.lastWorldId) {
                    setLastWorldId(currentWorldId);
                }

                if (!areSystemInfoEqual(latest.system, data.system)) setSystem(data.system);
                // A recovering socket may be admitted to the public room
                // before the saved cookie can be restored. Its public roster
                // must not replace the retained authenticated user scope.
                const authenticatedProjection = Object.prototype.hasOwnProperty.call(data, 'worldId');
                if (data.connected && (authenticatedProjection || !latest.token) && !areUsersEqual(latest.users, data.users)) {
                    setUsers((data.users || []) as User[]);
                }
                if (data.appVersion && latest.appVersion !== data.appVersion) setAppVersion(data.appVersion);
                if (data.isConfigured !== undefined && latest.isConfigured !== data.isConfigured) setIsConfigured(data.isConfigured);

                let targetStep = determineConnectionStep(data, latest.step, {
                    isConfigured: latest.isConfigured,
                    isAuthenticated: !!latest.token && latest.linkState === 'ready',
                    isExplicitLogoutPending: isExplicitLogoutPending(),
                });
                // A protected cookie is still being verified. Do not turn a
                // retained page into login merely because a public socket
                // status arrives before restored authority is checked.
                if (latest.token && latest.linkState !== 'ready' && targetStep === 'login') {
                    targetStep = latest.step === 'dashboard' ? 'dashboard' : 'authenticating';
                }

                if (latest.step !== targetStep) {
                    setStep(targetStep, 'socket', `Status change: ${targetStep}`);
                    if (targetStep === 'dashboard' && data.connected && latest.linkState === 'ready') {
                        void latest.fetchActors();
                    }
                }
            } catch (e) {
                logger.error('FoundryProvider | Error handling system status:', e);
            }
        };

        appSocket.on('systemStatus', handleSystemStatus);
        return () => {
            appSocket.off('systemStatus', handleSystemStatus);
        };
    }, [
        appSocket,
        isExplicitLogoutPending,
        resetActorCombatState,
        setAppVersion,
        setIsConfigured,
        setLastWorldId,
        setSharedContent,
        setStep,
        setSystem,
        invalidateLocalSession,
        setUsers,
    ]);
}
