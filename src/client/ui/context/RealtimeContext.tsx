'use client';

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { Loader2 } from 'lucide-react';
import { logger } from '@shared/utils/logger';
import { useSession } from '@client/ui/context/SessionContext';
import * as foundryApi from '@client/ui/api/foundryApi';
import { isRuntimeRestartReady } from '@shared/runtime/fullStackRestart';
import type {
    RealtimeServerRestartingPayload,
    RealtimeSessionInvalidatedPayload,
} from '@shared/contracts/realtime';

interface RealtimeContextType {
    appSocket: Socket | null;
}

const RealtimeContext = createContext<RealtimeContextType | undefined>(undefined);

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
    const { token, invalidateLocalSession, isExplicitLogoutPending } = useSession();
    const [appSocket, setAppSocket] = useState<Socket | null>(null);
    const [serverRestarting, setServerRestarting] = useState(false);

    useEffect(() => {
        let restartRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
        let restartRecoveryActive = false;

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

        socket.on('connect', () => {
            logger.debug('RealtimeContext | App Socket Connected');
        });

        socket.on('connect_error', (error) => {
            const isNoisyError =
                error.message === 'xhr poll error' ||
                error.message === 'websocket error' ||
                error.message.includes('timeout');

            if (isNoisyError) {
                logger.debug('RealtimeContext | App Socket Reconnection attempt failed:', error.message);
            } else {
                logger.error('RealtimeContext | App Socket Connection Error:', error.message);
            }
        });

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

            restartRecoveryTimer = setTimeout(pollForRestartRecovery, 1_000);
        };

        socket.on('serverRestarting', (payload: RealtimeServerRestartingPayload) => {
            if (restartRecoveryActive) return;
            restartRecoveryActive = true;
            logger.info(`RealtimeContext | Server restart announced (${payload.reason}).`);
            setServerRestarting(true);
            restartRecoveryTimer = setTimeout(pollForRestartRecovery, 1_000);
        });

        setAppSocket(socket);

        return () => {
            if (restartRecoveryTimer) clearTimeout(restartRecoveryTimer);
            socket.disconnect();
            setAppSocket(null);
        };
    }, [invalidateLocalSession, isExplicitLogoutPending, token]);

    const value = useMemo(() => ({ appSocket }), [appSocket]);

    return (
        <RealtimeContext.Provider value={value}>
            {children}
            {serverRestarting && (
                <div
                    className="fixed inset-0 z-[250] flex items-center justify-center bg-neutral-950/95 px-6 text-white"
                    role="status"
                    aria-live="assertive"
                >
                    <div className="flex max-w-md flex-col items-center gap-4 text-center">
                        <Loader2 className="h-10 w-10 animate-spin text-amber-400" aria-hidden="true" />
                        <h2 className="text-2xl font-bold">Applying module changes</h2>
                        <p className="text-sm text-neutral-300">
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
