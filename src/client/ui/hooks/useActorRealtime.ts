'use client';

import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import type { ActorCardData } from '@shared/sdk';
import type { ActorListPayload } from '@shared/contracts/actors';
import type { RealtimeActorListInvalidatedPayload } from '@shared/contracts/realtime';
import * as foundryApi from '@client/ui/api/foundryApi';

interface UseActorRealtimeOptions {
    appSocket: Socket | null;
    token: string | null;
    actorCards: Record<string, ActorCardData>;
    patchActorCard: (actorId: string, card: ActorCardData) => void;
    fetchActors: () => Promise<ActorListPayload | void>;
}

export function useActorRealtime({
    appSocket,
    token,
    actorCards,
    patchActorCard,
    fetchActors,
}: UseActorRealtimeOptions) {
    const latestRef = useRef({
        token,
        actorCards,
        patchActorCard,
        fetchActors,
    });

    useEffect(() => {
        latestRef.current = {
            token,
            actorCards,
            patchActorCard,
            fetchActors,
        };
    }, [actorCards, fetchActors, patchActorCard, token]);

    useEffect(() => {
        if (!appSocket) return;

        const handleActorChanged = async (data: { actorId?: string }) => {
            const latest = latestRef.current;
            if (!data.actorId || !latest.token) return;

            try {
                const card = await foundryApi.fetchActorCardById(latest.token, data.actorId);
                if (!card) return;
                const isNew = !latest.actorCards[data.actorId];
                latest.patchActorCard(data.actorId, card);
                if (isNew) void latest.fetchActors();
            } catch {
                void latest.fetchActors();
            }
        };
        const handleActorListInvalidated = (_data: RealtimeActorListInvalidatedPayload) => {
            // Membership and projection-band changes require the authoritative
            // list payload; a card-only refresh cannot move an Actor between
            // owned, read-only, limited-card, and hidden collections.
            void latestRef.current.fetchActors();
        };

        appSocket.on('actorChanged', handleActorChanged);
        appSocket.on('actorListInvalidated', handleActorListInvalidated);
        return () => {
            appSocket.off('actorChanged', handleActorChanged);
            appSocket.off('actorListInvalidated', handleActorListInvalidated);
        };
    }, [appSocket]);
}
