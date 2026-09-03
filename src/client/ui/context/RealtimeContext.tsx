'use client';

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { logger } from '@shared/utils/logger';
import { useSession } from '@client/ui/context/SessionContext';
import type { RealtimeSessionInvalidatedPayload } from '@shared/contracts/realtime';

interface RealtimeContextType {
    appSocket: Socket | null;
}

const RealtimeContext = createContext<RealtimeContextType | undefined>(undefined);

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
    const { token, invalidateLocalSession, isExplicitLogoutPending } = useSession();
    const [appSocket, setAppSocket] = useState<Socket | null>(null);

    useEffect(() => {
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

        setAppSocket(socket);

        return () => {
            socket.disconnect();
            setAppSocket(null);
        };
    }, [invalidateLocalSession, isExplicitLogoutPending, token]);

    const value = useMemo(() => ({ appSocket }), [appSocket]);

    return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
    const context = useContext(RealtimeContext);
    if (!context) {
        throw new Error('useRealtime must be used within a RealtimeProvider');
    }
    return context;
}
