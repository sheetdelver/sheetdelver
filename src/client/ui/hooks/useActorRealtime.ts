'use client';

import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import type { ActorCardData } from '@shared/sdk';
import type { ActorListPayload } from '@shared/contracts/actors';
import type { RealtimeActorListInvalidatedPayload } from '@shared/contracts/realtime';
import * as foundryApi from '@client/ui/api/foundryApi';
import { createCoalescedFetch, type CoalescedFetch } from '@client/ui/context/coalescedFetch';

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
    const cardFetchersRef = useRef(new Map<string, CoalescedFetch<ActorCardData>>());

    useEffect(() => {
        latestRef.current = {
            token,
            actorCards,
            patchActorCard,
            fetchActors,
        };
    }, [actorCards, fetchActors, patchActorCard, token]);

    useEffect(() => {
        // Session identity is part of each request key. Discard old coalescers
        // when it changes; stale-completion rejection is handled by the epoch
        // work that follows this convergence slice.
        cardFetchersRef.current.clear();
    }, [token]);

    useEffect(() => {
        if (!appSocket) return;

        const handleActorChanged = (data: { actorId?: string }) => {
            const latest = latestRef.current;
            if (!data.actorId || !latest.token) return;

            const key = `${latest.token}:${data.actorId}`;
            let fetcher = cardFetchersRef.current.get(key);
            if (!fetcher) {
                const sessionToken = latest.token;
                const actorId = data.actorId;
                fetcher = createCoalescedFetch<ActorCardData>(async () => {
                    try {
                        const card = await foundryApi.fetchActorCardById(sessionToken, actorId);
                        if (!card || latestRef.current.token !== sessionToken) return;
                        const current = latestRef.current;
                        const isNew = !current.actorCards[actorId];
                        current.patchActorCard(actorId, card);
                        if (isNew) void current.fetchActors();
                        return card;
                    } catch {
                        if (latestRef.current.token === sessionToken) {
                            void latestRef.current.fetchActors();
                        }
                    }
                });
                cardFetchersRef.current.set(key, fetcher);
            }
            // Repeated changes for one Actor serialize into a final read that
            // begins after the newest observed invalidation.
            void fetcher();
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
