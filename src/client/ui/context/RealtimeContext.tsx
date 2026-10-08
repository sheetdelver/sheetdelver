'use client';

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { Loader2 } from 'lucide-react';
import { logger } from '@shared/utils/logger';
import { useSession } from '@client/ui/context/SessionContext';
import { COOKIE_SESSION_MARKER } from '@client/ui/context/SessionContext';
import * as foundryApi from '@client/ui/api/foundryApi';
import { ApiError, UnauthorizedApiError } from '@client/ui/api/http';
import { isRuntimeRestartReady } from '@shared/runtime/fullStackRestart';
import type { RealtimeStatusPayload } from '@shared/contracts/status';
import type {
    RealtimeServerRestartingPayload,
    RealtimeSessionInvalidatedPayload,
} from '@shared/contracts/realtime';

interface RealtimeContextType {
    appSocket: Socket | null;
    linkState: 'connecting' | 'checking' | 'ready' | 'guest' | 'disconnected' | 'unavailable';
}

const RealtimeContext = createContext<RealtimeContextType | undefined>(undefined);

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
    const { token, currentUserId, setCurrentUserId, setToken, invalidateLocalSession, isExplicitLogoutPending } = useSession();
    const [appSocket, setAppSocket] = useState<Socket | null>(null);
    const [linkState, setLinkState] = useState<RealtimeContextType['linkState']>('connecting');
    const [serverRestarting, setServerRestarting] = useState(false);
    const currentUserIdRef = useRef(currentUserId);
    useEffect(() => { currentUserIdRef.current = currentUserId; }, [currentUserId]);

    useEffect(() => {
        setLinkState('connecting');
        let restartRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
        let restartRecoveryActive = false;
        let restartStartedAt = 0;
        let disposed = false;
        let unavailable = false;
        let validated = false;
        let worldReady = false;
        let guestConfirmed = false;
        let audience: 'unknown' | 'public' | 'authenticated' = 'unknown';
        let deliberateRehandshake = false;
        let connectionGeneration = 0;
        let checkingGeneration: number | null = null;
        let lastCheckAt = 0;
        let outageLogged = false;

        const socket = io({
            // Socket.IO sends the HttpOnly session cookie during polling and
            // websocket upgrade; no reusable token enters handshake.auth.
            withCredentials: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 2000,
            reconnectionDelayMax: 5000,
            randomizationFactor: 0.5,
            timeout: 10000,
            transports: ['polling', 'websocket'],
        });

        const giveUp = (reason: string) => {
            if (unavailable || disposed || restartRecoveryActive) return;
            unavailable = true;
            setLinkState('unavailable');
            logger.warn(`RealtimeContext | Browser connection unavailable (${reason}); waiting for reload.`);
            socket.disconnect();
        };

        const finishAuthorization = () => {
            if (disposed || unavailable || !validated || !worldReady || !socket.connected) return;
            if (audience === 'authenticated') {
                setLinkState('ready');
                if (outageLogged) logger.info('RealtimeContext | Browser connection recovered.');
                outageLogged = false;
                deliberateRehandshake = false;
                return;
            }
            if (audience === 'public') {
                if (deliberateRehandshake) {
                    giveUp('authenticated room unavailable');
                    return;
                }
                deliberateRehandshake = true;
                // The cookie was restored after this socket joined the public
                // room. One new handshake lets server middleware authenticate it.
                socket.disconnect().connect();
            }
        };

        const verifyCurrentCookie = () => {
            if (disposed || unavailable || guestConfirmed || !socket.connected || checkingGeneration === connectionGeneration) return;
            const verificationGeneration = connectionGeneration;
            checkingGeneration = verificationGeneration;
            lastCheckAt = Date.now();
            void (async () => {
                try {
                    const result = await foundryApi.fetchSessionUsers();
                    if (disposed || unavailable || !socket.connected || verificationGeneration !== connectionGeneration) return;
                    if (!result.currentUserId) {
                        giveUp('identity missing from protected response');
                        return;
                    }
                    if (currentUserIdRef.current && currentUserIdRef.current !== result.currentUserId) {
                        socket.disconnect();
                        invalidateLocalSession('authenticated-user-changed');
                        setLinkState('guest');
                        return;
                    }
                    currentUserIdRef.current = result.currentUserId;
                    setCurrentUserId(result.currentUserId);
                    validated = true;
                    if (!token) {
                        // The marker is not a credential. Its transition also
                        // replaces a cold-load public socket with a fresh one.
                        setToken(COOKIE_SESSION_MARKER);
                        return;
                    }
                    finishAuthorization();
                } catch (error) {
                    if (disposed || unavailable || verificationGeneration !== connectionGeneration) return;
                    if (error instanceof UnauthorizedApiError) {
                        if (token || audience === 'authenticated') socket.disconnect();
                        if (token) invalidateLocalSession('protected-session-401');
                        else guestConfirmed = true;
                        setLinkState('guest');
                    } else if (error instanceof ApiError && error.status === 503) {
                        setLinkState('checking');
                    } else {
                        logger.debug('RealtimeContext | Protected session check unavailable:', error);
                        setLinkState('checking');
                    }
                } finally {
                    if (checkingGeneration === verificationGeneration) checkingGeneration = null;
                }
            })();
        };

        socket.on('connect', () => {
            if (unavailable) return;
            connectionGeneration += 1;
            audience = 'unknown';
            validated = false;
            worldReady = false;
            setLinkState('checking');
            logger.debug('RealtimeContext | App Socket Connected');
            verifyCurrentCookie();
        });

        socket.on('systemStatus', (status: RealtimeStatusPayload) => {
            if (unavailable || disposed) return;
            audience = Object.prototype.hasOwnProperty.call(status, 'worldId')
                ? 'authenticated' : 'public';
            worldReady = status.connected && status.initialized
                && (!status.system?.status || status.system.status === 'active');
            if (token && !worldReady) {
                validated = false;
                setLinkState('checking');
            }
            if (validated) finishAuthorization();
            if (!validated && worldReady && Date.now() - lastCheckAt >= 5_000) {
                verifyCurrentCookie();
            }
        });

        socket.on('disconnect', () => {
            if (disposed || unavailable || restartRecoveryActive) return;
            validated = false;
            worldReady = false;
            setLinkState('disconnected');
            if (!outageLogged && !deliberateRehandshake) {
                logger.info('RealtimeContext | Browser connection interrupted.');
                outageLogged = true;
            }
        });

        socket.on('connect_error', (error) => {
            if (disposed || unavailable || restartRecoveryActive) return;
            if (!socket.active) {
                giveUp((error as Error & { data?: { code?: string } }).data?.code || 'handshake rejected');
            } else {
                logger.debug('RealtimeContext | App Socket Reconnection attempt failed:', error.message);
            }
        });

        socket.io.on('reconnect_failed', () => giveUp('reconnect budget exhausted'));

        socket.on('sessionInvalidated', (payload: RealtimeSessionInvalidatedPayload) => {
            logger.info(`RealtimeContext | Server session invalidated (${payload.reason}).`);
            if (isExplicitLogoutPending()) {
                // The gateway has already removed authenticated authority and
                // moved this transport into the public status room. Keep it
                // long enough to observe Foundry's logout presence update.
                return;
            }
            // Stop this authenticated transport before clearing React state so
            // no queued world-backed event can arrive during the rerender. The
            // token transition creates a fresh public-status socket.
            socket.disconnect();
            invalidateLocalSession(payload.reason);
            setLinkState('guest');
        });

        const pollForRestartRecovery = async () => {
            try {
                const status = await foundryApi.fetchStatus(token);
                if (isRuntimeRestartReady(status)) {
                    window.location.reload();
                    return;
                }
            } catch {
                // The complete stack is expected to be unreachable while its
                // supervisor replaces the Core and application-shell processes.
            }

            restartRecoveryTimer = setTimeout(
                pollForRestartRecovery,
                Date.now() - restartStartedAt < 30_000 ? 1_000 : 5_000,
            );
        };

        socket.on('serverRestarting', (payload: RealtimeServerRestartingPayload) => {
            if (restartRecoveryActive) return;
            restartRecoveryActive = true;
            restartStartedAt = Date.now();
            logger.info(`RealtimeContext | Server restart announced (${payload.reason}).`);
            setServerRestarting(true);
            restartRecoveryTimer = setTimeout(pollForRestartRecovery, 1_000);
        });

        setAppSocket(socket);

        return () => {
            disposed = true;
            if (restartRecoveryTimer) clearTimeout(restartRecoveryTimer);
            socket.disconnect();
            setAppSocket(null);
        };
    }, [invalidateLocalSession, isExplicitLogoutPending, setCurrentUserId, setToken, token]);

    const value = useMemo(() => ({ appSocket, linkState }), [appSocket, linkState]);

    return (
        <RealtimeContext.Provider value={value}>
            {children}
            {serverRestarting && (
                <div
                    className="sd-ui-overlay fixed inset-0 z-[250] flex items-center justify-center px-6"
                    role="status"
                    aria-live="assertive"
                >
                    <div className="flex max-w-md flex-col items-center gap-4 text-center">
                        <Loader2 className="sd-ui-accent h-10 w-10 animate-spin" aria-hidden="true" />
                        <h2 className="text-2xl font-bold">Applying module changes</h2>
                        <p className="sd-ui-muted text-sm">
                            Sheet Delver will resume when the world runtime is ready.
                        </p>
                    </div>
                </div>
            )}
        </RealtimeContext.Provider>
    );
}

export function useRealtime() {
    const context = useContext(RealtimeContext);
    if (!context) {
        throw new Error('useRealtime must be used within a RealtimeProvider');
    }
    return context;
}
