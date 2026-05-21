import type { FoundryClientLike } from '@server/shared/types/foundry';
import type { RollMode } from '@shared/sdk';

/**
 * Foundry Item document shape. Shared between embedded-on-Actor items and
 * world-level items — same Foundry document type with or without a parent.
 * World-level fields (`folder`, `img`, `sort`, `ownership`, `flags`, `_stats`)
 * are no-op on embedded items and load-bearing on world items.
 */
export interface ItemDocument {
    id?: string;
    _id?: string;
    name?: string;
    type?: string;
    img?: string | null;
    folder?: string | null;
    system?: Record<string, unknown>;
    effects?: unknown[];
    sort?: number;
    ownership?: Record<string, number>;
    flags?: Record<string, unknown>;
    _stats?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface ActorDocument {
    id?: string;
    _id?: string;
    name?: string;
    type?: string;
    img?: string;
    folder?: string | null;
    ownership?: Record<string, number>;
    prototypeToken?: {
        texture?: {
            src?: string;
        };
    };
    items?: ItemDocument[];
    categorizedItems?: Record<string, ItemDocument[]>;
    computed?: {
        resolvedNames?: Record<string, string>;
        [key: string]: unknown;
    };
    system?: unknown;
    [key: string]: unknown;
}

export interface ActorCard {
    name?: string;
    img?: string;
    subtext?: string;
    blocks?: Array<{
        title: string;
        value: string | number;
        subValue?: string | number;
        valueClass?: string;
    }>;
    footer?: unknown;
    [key: string]: unknown;
}

export interface ActorRollPayload {
    type: string;
    key: string;
    options?: {
        rollMode?: RollMode;
        speaker?: {
            actor?: string;
            alias?: string;
        };
        [key: string]: unknown;
    };
}

export interface ActorServiceClientLike extends FoundryClientLike {
    url?: string;

    getSystem(): Promise<{ id: string }>;
    getActors(): Promise<ActorDocument[]>;
    getActor(actorId: string): Promise<(ActorDocument & { error?: string }) | null | undefined>;
    getActorRaw(actorId: string): Promise<(ActorDocument & { error?: string }) | null | undefined>;

    createActor(
        actorData: Record<string, unknown> | Array<Record<string, unknown>>
    ): Promise<ActorDocument | ActorDocument[] | null | undefined>;
    deleteActor(actorId: string): Promise<void>;
    updateActor(actorId: string, payload: Record<string, unknown>): Promise<unknown>;
    dispatchDocument(
        type: string,
        action: string,
        operation?: unknown,
        parent?: { type: string; id: string }
    ): Promise<unknown>;

    roll(
        formula: string,
        label: string,
        options?: { rollMode?: RollMode; speaker?: { actor?: string; alias?: string }; flags?: unknown }
    ): Promise<unknown>;
    useItem(actorId: string, itemId: string): Promise<unknown>;

    createActorItem(
        actorId: string,
        payload: Record<string, unknown> | Array<Record<string, unknown>>
    ): Promise<unknown>;
    updateActorItem(actorId: string, payload: Record<string, unknown>): Promise<void>;
    deleteActorItem(actorId: string, itemId: string): Promise<void>;

    resolveUrl(url?: string): string;
}
