'use client';

import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Socket } from 'socket.io-client';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';
import { areSharedContentEqual } from '@client/ui/context/foundryRealtimeComparisons';
import { latestSharedContent } from '@client/ui/context/sharedContentState';

interface UseSharedContentRealtimeOptions {
    appSocket: Socket | null;
    sharedContent: RealtimeSharedContentPayload | null;
    setSharedContent: Dispatch<SetStateAction<RealtimeSharedContentPayload | null>>;
}

interface SharedContentSocket {
    on(event: 'sharedContentUpdate', handler: (payload: RealtimeSharedContentPayload) => void): void;
    off(event: 'sharedContentUpdate', handler: (payload: RealtimeSharedContentPayload) => void): void;
}

interface SharedContentSubscriptionOptions {
    appSocket: SharedContentSocket;
    getSharedContent: () => RealtimeSharedContentPayload | null;
    setSharedContent: (payload: RealtimeSharedContentPayload) => void;
}

export function subscribeSharedContentRealtime({
    appSocket,
    getSharedContent,
    setSharedContent,
}: SharedContentSubscriptionOptions) {
    const handleSharedContentUpdate = (scData: RealtimeSharedContentPayload) => {
        const current = getSharedContent();
        const next = latestSharedContent(current, scData);
        if (next && !areSharedContentEqual(current, next)) {
            setSharedContent(next);
        }
    };

    appSocket.on('sharedContentUpdate', handleSharedContentUpdate);
    return () => {
        appSocket.off('sharedContentUpdate', handleSharedContentUpdate);
    };
}

export function useSharedContentRealtime({
    appSocket,
    sharedContent,
    setSharedContent,
}: UseSharedContentRealtimeOptions) {
    const sharedContentRef = useRef(sharedContent);

    useEffect(() => {
        sharedContentRef.current = sharedContent;
    }, [sharedContent]);

    useEffect(() => {
        if (!appSocket) return;
        return subscribeSharedContentRealtime({
            appSocket,
            getSharedContent: () => sharedContentRef.current,
            setSharedContent: next => {
                sharedContentRef.current = next;
                setSharedContent(next);
            },
        });
    }, [appSocket, setSharedContent]);
}
