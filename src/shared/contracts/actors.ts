import type { ActorCardData } from '@shared/sdk';

export interface ActorDto {
    id?: string;
    _id?: string;
    name?: string;
    type?: string;
    img?: string;
    ownership?: Record<string, number>;
    system?: unknown;
    items?: unknown[];
    derived?: Record<string, unknown>;
    categorizedItems?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface ActorListPayload {
    actors: ActorDto[];
    ownedActors: ActorDto[];
    readOnlyActors: ActorDto[];
    system: string;
}

export type ActorCardsPayload = Record<string, ActorCardData>;

export interface ActorDetailPayload extends ActorDto {
    foundryUrl?: string;
    systemId?: string;
    debugLevel?: number;
}

export interface ActorErrorPayload {
    error: string;
    status: number;
}
