'use client';

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { logger } from '@shared/utils/logger';
import { useSession } from '@client/ui/context/SessionContext';
import { UnauthorizedApiError } from '@client/ui/api/http';
import * as foundryApi from '@client/ui/api/foundryApi';
import type { ActorDto, ActorListPayload, ActorCardsPayload } from '@shared/contracts/actors';
import type { CombatDto, CombatListPayload } from '@shared/contracts/combats';
import type { ActorCardData } from '@shared/sdk';

interface ActorCombatContextType {
    ownedActors: ActorDto[];
    readOnlyActors: ActorDto[];
    actorCards: Record<string, ActorCardData>;
    combats: CombatDto[];
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
    const [combats, setCombats] = useState<CombatDto[]>([]);
    const lastActorFetchTimeRef = useRef<number>(0);
    const FETCH_THROTTLE_MS = 2000;

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

        const now = Date.now();
        if (now - lastActorFetchTimeRef.current < FETCH_THROTTLE_MS) {
            logger.debug('ActorCombatContext | Skipping fetchActors (throttled)');
            return;
        }

        lastActorFetchTimeRef.current = now;

        try {
            const data = await foundryApi.fetchActors(token);
            if (data.ownedActors || data.actors) {
                setOwnedActors(data.ownedActors || data.actors || []);
                setReadOnlyActors(data.readOnlyActors || []);
                await fetchActorCards();
            }
            return data;
        } catch (error: any) {
            if (error instanceof UnauthorizedApiError) {
                setToken(null);
                return;
            }
            logger.error('ActorCombatContext | Fetch actors failed:', error.message);
        }
    }, [fetchActorCards, token, setToken]);

    const fetchCombats = useCallback(async () => {
        if (!token) return;
        try {
            const data = await foundryApi.fetchCombats(token);
            if (data.combats) {
                setCombats(data.combats as CombatDto[]);
            }
            return data;
        } catch (error: any) {
            if (error instanceof UnauthorizedApiError) {
                setToken(null);
                return;
            }
            logger.error('ActorCombatContext | Fetch combat failed:', error.message);
        }
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
