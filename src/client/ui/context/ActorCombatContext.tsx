'use client';

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { logger } from '@shared/utils/logger';
import { useSession } from '@client/ui/context/SessionContext';
import { UnauthorizedApiError } from '@client/ui/api/http';
import { createCoalescedFetch } from '@client/ui/context/coalescedFetch';
import * as foundryApi from '@client/ui/api/foundryApi';
import type { ActorDto, ActorListPayload, ActorCardsPayload } from '@shared/contracts/actors';
import type { CombatTrackerDto, CombatListPayload } from '@shared/contracts/combats';
import type { ActorCardData } from '@shared/sdk';

interface ActorCombatContextType {
    ownedActors: ActorDto[];
    readOnlyActors: ActorDto[];
    actorCards: Record<string, ActorCardData>;
    combats: CombatTrackerDto[];
    fetchActorCards: () => Promise<ActorCardsPayload | void>;
    fetchActors: () => Promise<ActorListPayload | void>;
    fetchCombats: () => Promise<CombatListPayload | void>;
    patchActorCard: (actorId: string, card: ActorCardData) => void;
    resetActorCombatState: () => void;
}

const ActorCombatContext = createContext<ActorCombatContextType | undefined>(undefined);

export function ActorCombatProvider({ children }: { children: React.ReactNode }) {
    const { token, setToken } = useSession();
    const [ownedActors, setOwnedActors] = useState<ActorDto[]>([]);
    const [readOnlyActors, setReadOnlyActors] = useState<ActorDto[]>([]);
    const [actorCards, setActorCards] = useState<Record<string, ActorCardData>>({});
    const [combats, setCombats] = useState<CombatTrackerDto[]>([]);
    const actorFetcherRef = useRef<{
        token: string;
        fetch: () => Promise<ActorListPayload | void>;
    } | null>(null);
    const combatFetcherRef = useRef<{
        token: string;
        fetch: () => Promise<CombatListPayload | void>;
    } | null>(null);
    const fetchActorCards = useCallback(async () => {
        if (!token) return;
        try {
            const data = await foundryApi.fetchActorCards(token);
            setActorCards(data || {});
            return data;
        } catch (error) {
            if (error instanceof UnauthorizedApiError) {
                setToken(null);
                return;
            }
            logger.error('ActorCombatContext | Failed to fetch actor cards:', error);
        }
    }, [token, setToken]);

    const fetchActors = useCallback(async () => {
        if (!token) return;
        if (actorFetcherRef.current?.token !== token) {
            actorFetcherRef.current = {
                token,
                // An invalidation during an in-flight list request must queue a
                // trailing read; otherwise its older snapshot can overwrite the
                // ownership state which triggered the invalidation.
                fetch: createCoalescedFetch<ActorListPayload>(async () => {
                    try {
                        const data = await foundryApi.fetchActors(token);
                        if (data.ownedActors || data.actors) {
                            setOwnedActors(data.ownedActors || data.actors || []);
                            setReadOnlyActors(data.readOnlyActors || []);
                            if (data.actorCards) {
                                // Newer backends return cards with the actor list to avoid a
                                // second `/api/actors/cards` request during dashboard load.
                                setActorCards(data.actorCards);
                            } else {
                                // Compatibility path for older payloads and partial responses.
                                await fetchActorCards();
                            }
                        }
                        return data;
                    } catch (error: any) {
                        if (error instanceof UnauthorizedApiError) {
                            setToken(null);
                            return;
                        }
                        logger.error('ActorCombatContext | Fetch actors failed:', error.message);
                        return;
                    }
                }),
            };
        }
        return actorFetcherRef.current.fetch();
    }, [fetchActorCards, token, setToken]);

    // Coalesced with a trailing-refetch guarantee: an invalidation arriving
    // while a request is in flight always causes one more fetch after it
    // settles (ADR-0028 / CMB-05), so a pre-change snapshot can't become the
    // final combat state. The fetcher is rebuilt when the session token
    // changes, discarding any in-flight state from the previous session.
    const fetchCombats = useCallback(async () => {
        if (!token) return;
        if (combatFetcherRef.current?.token !== token) {
            combatFetcherRef.current = {
                token,
                fetch: createCoalescedFetch<CombatListPayload>(async () => {
                    try {
                        const data = await foundryApi.fetchCombats(token);
                        if (data.combats) {
                            setCombats(data.combats);
                        }
                        return data;
                    } catch (error: any) {
                        if (error instanceof UnauthorizedApiError) {
                            setToken(null);
                            return;
                        }
                        logger.error('ActorCombatContext | Fetch combat failed:', error.message);
                        return;
                    }
                }),
            };
        }
        return combatFetcherRef.current.fetch();
    }, [token, setToken]);

    const patchActorCard = useCallback((actorId: string, card: ActorCardData) => {
        setActorCards(prev => ({ ...prev, [actorId]: card }));
    }, []);

    const resetActorCombatState = useCallback(() => {
        setOwnedActors([]);
        setReadOnlyActors([]);
        setActorCards({});
        setCombats([]);
    }, []);

    const value = useMemo(() => ({
        ownedActors,
        readOnlyActors,
        actorCards,
        combats,
        fetchActorCards,
        fetchActors,
        fetchCombats,
        patchActorCard,
        resetActorCombatState,
    }), [
        ownedActors,
        readOnlyActors,
        actorCards,
        combats,
        fetchActorCards,
        fetchActors,
        fetchCombats,
        patchActorCard,
        resetActorCombatState,
    ]);

    return <ActorCombatContext.Provider value={value}>{children}</ActorCombatContext.Provider>;
}

export function useActorCombat() {
    const context = useContext(ActorCombatContext);
    if (!context) {
        throw new Error('useActorCombat must be used within an ActorCombatProvider');
    }
    return context;
}
