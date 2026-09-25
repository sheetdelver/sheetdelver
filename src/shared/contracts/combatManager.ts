/** GM-only, whitelisted Combat Manager API. Foundry source documents never cross this boundary. */
export interface CombatManagerResourceDto {
    path: string;
    value: number;
    max: number | null;
    editable: boolean;
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

export interface CombatManagerPackDto {
    id: string;
    label: string;
}

export type CombatManagerInitiativeScope = 'all' | 'npc';

export interface CombatManagerInitiativeBatchDto {
    rolled: number;
    encounter: CombatManagerEncounterDto;
}
