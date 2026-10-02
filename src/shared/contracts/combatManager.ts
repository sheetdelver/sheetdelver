/** GM-only, whitelisted Combat Manager API. Foundry source documents never cross this boundary. */
import type { ModuleCombatStatAttribute } from '@shared/sdk';

/** Core-owned GM selection; module info.json suggestions remain read-only. */
export interface CombatManagerSelectedStatDto extends ModuleCombatStatAttribute {
    editable?: true;
    /** The one GM-selected stat used by roster health actions. */
    health?: true;
}

export interface CombatManagerAvailableStatDto extends ModuleCombatStatAttribute {
    /** Actor types where the field was observed; not a saved display restriction. */
    observedActorTypes: string[];
}

export interface CombatManagerStatPreferencesDto {
    source: 'saved' | 'module' | 'none';
    attributes: CombatManagerSelectedStatDto[];
    suggestions: ModuleCombatStatAttribute[];
    available: CombatManagerAvailableStatDto[];
}
export interface CombatManagerResourceDto {
    path: string;
    value: number;
    max: number | null;
    editable: boolean;
}

/** The value and source identity shown when a GM began a resource edit. */
export interface CombatManagerResourceUpdateRequest {
    value: number;
    expected: { actorId: string; path: string; value: number };
}

/** Bounded stat projection; edit is present only for a verified Actor source field. */
export interface CombatManagerStatDto {
    title: string;
    value: string | number;
    subValue?: string | number;
    showInRoster?: true;
    health?: true;
    edit?: { key: string; path: string; value: number; max?: number };
}

export interface CombatManagerStatUpdateRequest {
    value: number;
    expected: { actorId: string; path: string; value: number };
}

export interface CombatManagerParticipantDto {
    id: string;
    actorId: string;
    source: 'world' | 'compendium-copy';
    /** Foundry-style NPC: no non-GM user owns the associated world Actor. */
    isNpc: boolean;
    name: string;
    img: string | null;
    initiative: number | null;
    hidden: boolean;
    defeated: boolean;
    isCurrent: boolean;
    resource: CombatManagerResourceDto | null;
    effects: string[];
    stats: CombatManagerStatDto[];
}

export interface CombatManagerEncounterDto {
    id: string;
    label: string;
    status: 'provisioning' | 'active' | 'cleaning' | 'completed';
    keepHistory: boolean;
    round: number;
    currentCombatantId: string | null;
    participants: CombatManagerParticipantDto[];
}

export interface CombatManagerActorChoiceDto {
    id: string;
    name: string;
    img: string | null;
    type: string | null;
    source: 'world' | 'compendium';
    packId?: string;
}

export type CombatManagerSortDirection = 'asc' | 'desc';

/** Picker sort keys are independent of saved combat-stat display preferences. */
export interface CombatManagerActorSortRequest {
    nameDirection: CombatManagerSortDirection;
    fields: Array<{ path: string; direction: CombatManagerSortDirection }>;
}

export interface CombatManagerActorSortFieldDto {
    path: string;
    label: string;
    kind: 'number' | 'text';
}

export interface CombatManagerActorSearchDto {
    actors: CombatManagerActorChoiceDto[];
    sortFields: CombatManagerActorSortFieldDto[];
}

export interface CombatManagerPackDto {
    id: string;
    label: string;
}

export type CombatManagerInitiativeScope = 'all' | 'npc';

export interface CombatManagerInitiativeBatchDto {
    rolled: number;
    encounter: CombatManagerEncounterDto;
}
