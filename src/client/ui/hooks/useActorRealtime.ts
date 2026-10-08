'use client';

import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import type { ActorCardData } from '@shared/sdk';
import type { ActorListPayload } from '@shared/contracts/actors';
import type { RealtimeActorListInvalidatedPayload } from '@shared/contracts/realtime';
import * as foundryApi from '@client/ui/api/foundryApi';
import { createCoalescedFetch, type CoalescedFetch } from '@client/ui/context/coalescedFetch';
import { useSession } from '@client/ui/context/SessionContext';
import { useRealtime } from '@client/ui/context/RealtimeContext';

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
    const { sessionEpoch } = useSession();
    const { linkState } = useRealtime();
    const latestRef = useRef({
        token,
        sessionEpoch,
        linkState,
        actorCards,
        patchActorCard,
        fetchActors,
    });
    const cardFetchersRef = useRef(new Map<string, CoalescedFetch<ActorCardData>>());

    useEffect(() => {
        latestRef.current = {
            token,
            sessionEpoch,
            linkState,
            actorCards,
            patchActorCard,
            fetchActors,
        };
    }, [actorCards, fetchActors, linkState, patchActorCard, sessionEpoch, token]);

    useEffect(() => {
        // Session identity is part of each request key. Discard old coalescers
        // when it changes; stale-completion rejection is handled by the epoch
        // work that follows this convergence slice.
        cardFetchersRef.current.clear();
    }, [sessionEpoch, token]);

    useEffect(() => {
        if (!appSocket) return;

        const handleActorChanged = (data: { actorId?: string }) => {
            const latest = latestRef.current;
            if (!data.actorId || !latest.token || latest.linkState !== 'ready') return;

            const key = `${latest.sessionEpoch}:${data.actorId}`;
            let fetcher = cardFetchersRef.current.get(key);
            if (!fetcher) {
                const sessionToken = latest.token;
                const requestEpoch = latest.sessionEpoch;
                const actorId = data.actorId;
                fetcher = createCoalescedFetch<ActorCardData>(async () => {
                    try {
                        const card = await foundryApi.fetchActorCardById(sessionToken, actorId);
                        if (!card || latestRef.current.linkState !== 'ready' || latestRef.current.token !== sessionToken || latestRef.current.sessionEpoch !== requestEpoch) return;
                        const current = latestRef.current;
                        const isNew = !current.actorCards[actorId];
                        current.patchActorCard(actorId, card);
                        if (isNew) void current.fetchActors();
                        return card;
                    } catch {
                        if (latestRef.current.linkState === 'ready' && latestRef.current.token === sessionToken && latestRef.current.sessionEpoch === requestEpoch) {
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
            if (latestRef.current.linkState === 'ready') void latestRef.current.fetchActors();
        };

        appSocket.on('actorChanged', handleActorChanged);
        appSocket.on('actorListInvalidated', handleActorListInvalidated);
        return () => {
            appSocket.off('actorChanged', handleActorChanged);
            appSocket.off('actorListInvalidated', handleActorListInvalidated);
        };
    }, [appSocket]);
}
