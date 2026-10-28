'use client';

import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo } from 'react';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { useSession } from '@client/ui/context/SessionContext';
import { createSdkEventBus } from '@client/ui/sdk/createSdkEventBus';
import type { SdkEvents } from '@shared/sdk/events';

const SDKEventsContext = createContext<SdkEvents | null>(null);

/** Keep replay cleanup separate from retirement of the authenticated owner. */
function createLifetime(scope: string) {
    const bus = createSdkEventBus();
    let generation = 0;
    return { scope, bus, retain() {
        const retained = ++generation;
        return () => {
            // Strict Mode replays effects on the same owner. Real retirement
            // disposes subscribers after that synchronous replay has finished.
            queueMicrotask(() => { if (retained === generation) bus.dispose(); });
        };
    }};
}

/** Authenticated Foundry workspace lifetime (GM and player), independent of pages. */
export function SDKEventsProvider({ children }: { children: React.ReactNode }) {
    const { appSocket, token, currentUser, worldId, system } = useFoundry();
    const { sessionEpoch } = useSession();
    const scope = JSON.stringify([!!token, sessionEpoch, worldId, currentUser?.id ?? currentUser?._id,
        currentUser?.role, currentUser?.isGM, system?.id]);
    const lifetime = useMemo(() => createLifetime(scope), [scope]);
    const events = useMemo<SdkEvents>(() => ({ on: (signal, handler) => lifetime.bus.on(signal, handler) }), [lifetime]);

    useEffect(() => lifetime.retain(), [lifetime]);
    const authenticated = !!token && !!currentUser && !!worldId;
    useLayoutEffect(() => {
        lifetime.bus.attach(authenticated ? appSocket : null);
        return () => lifetime.bus.detach();
    }, [lifetime, appSocket, authenticated]);

    return <SDKEventsContext.Provider value={events}>{children}</SDKEventsContext.Provider>;
}

export function useSDKEvents(): SdkEvents {
    const events = useContext(SDKEventsContext);
    if (!events) throw new Error('SDKProvider requires the workspace SDKEventsProvider.');
    return events;
}
