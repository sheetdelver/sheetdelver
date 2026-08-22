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
    setToken: (token: string | null) => void;
    setSharedContent: Dispatch<SetStateAction<RealtimeSharedContentPayload | null>>;
    setLastWorldId: Dispatch<SetStateAction<string | null>>;
    resetActorCombatState: () => void;
    fetchActors: () => Promise<ActorListPayload | void>;
}

export function useSystemStatusRealtime({
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
}: UseSystemStatusRealtimeOptions) {
    const latestRef = useRef({
        step,
        token,
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
            system,
            users,
            appVersion,
            isConfigured,
            lastWorldId,
            fetchActors,
        };
    }, [appVersion, fetchActors, isConfigured, lastWorldId, step, system, token, users]);

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
                    if (latest.token) setToken(null);
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

                    if (latest.token) setToken(null);
                    resetActorCombatState();
                    setUsers([]);
                    setSharedContent(null);

                    setLastWorldId(currentWorldId);
                } else if (data.connected && currentWorldId && !latest.lastWorldId) {
                    setLastWorldId(currentWorldId);
                }

                if (!areSystemInfoEqual(latest.system, data.system)) setSystem(data.system);
                if (data.connected && !areUsersEqual(latest.users, data.users)) setUsers((data.users || []) as User[]);
                if (data.appVersion && latest.appVersion !== data.appVersion) setAppVersion(data.appVersion);
                if (data.isConfigured !== undefined && latest.isConfigured !== data.isConfigured) setIsConfigured(data.isConfigured);

                const targetStep = determineConnectionStep(data, latest.step, {
                    isConfigured: latest.isConfigured,
                    isAuthenticated: !!latest.token,
                });

                if (latest.step !== targetStep) {
                    setStep(targetStep, 'socket', `Status change: ${targetStep}`);
                    if (targetStep === 'dashboard' && data.connected) {
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
        resetActorCombatState,
        setAppVersion,
        setIsConfigured,
        setLastWorldId,
        setSharedContent,
        setStep,
        setSystem,
        setToken,
        setUsers,
    ]);
}
