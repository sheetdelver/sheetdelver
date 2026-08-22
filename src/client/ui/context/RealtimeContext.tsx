'use client';

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { logger } from '@shared/utils/logger';
import { useSession } from '@client/ui/context/SessionContext';

interface RealtimeContextType {
    appSocket: Socket | null;
}

const RealtimeContext = createContext<RealtimeContextType | undefined>(undefined);

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
    const { token } = useSession();
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

        setAppSocket(socket);

        return () => {
            socket.disconnect();
            setAppSocket(null);
        };
    }, [token]);

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
