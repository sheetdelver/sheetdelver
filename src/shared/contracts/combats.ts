import type { ActorDto } from '@shared/contracts/actors';

export interface CombatantDto {
    id?: string;
    _id?: string;
    actorId?: string;
    // Foundry sends `null` for unrolled combatants.
    initiative?: number | null;
    actor?: ActorDto | null;
    [key: string]: unknown;
}

export interface CombatDto {
    id?: string;
    _id?: string;
    round?: number;
    // Foundry sends `null` for pre-start combats.
    turn?: number | null;
    combatants?: CombatantDto[];
    [key: string]: unknown;
}

export interface CombatListPayload {
    success: boolean;
    combats: CombatDto[];
}

export interface CombatTurnSuccessPayload {
    success: true;
    round: number;
    turn: number;
}

export interface CombatInitiativeSuccessPayload {
    success: true;
    initiative: number;
}

export interface CombatErrorPayload {
    error: string;
    status: number;
}
