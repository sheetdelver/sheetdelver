/** GM/Assistant, whitelisted Combat Manager API. Foundry source documents never cross this boundary. */
import type { ModuleCombatStatAttribute, ModuleCombatStatLayout } from '@shared/sdk';

/** Identity used only for detecting duplicate manager encounter labels. */
export function combatManagerNameKey(label: string): string {
    return label.trim().replace(/\s+/g, ' ').normalize('NFKC').toLocaleLowerCase();
}

/** Core-owned GM selection; module info.json suggestions remain read-only. */
export type CombatManagerStatKind = ModuleCombatStatAttribute['kind'];
/** Three-column detail grid; bounded spans/viewport avoid pathological layout. */
export const COMBAT_STAT_LAYOUT_LIMITS = { columns: 3, rows: 6, textRows: 12 } as const;
export type CombatManagerStatLayout = ModuleCombatStatLayout;

export interface CombatManagerSelectedStatDto extends ModuleCombatStatAttribute {
    editable?: true;
    /** The one GM-selected stat used by roster health actions. */
    health?: true;
}

export interface CombatManagerAvailableStatDto extends Omit<ModuleCombatStatAttribute, 'kind'> {
    kind: CombatManagerStatKind;
    /** Actor types where the field was observed; not a saved display restriction. */
    observedActorTypes: string[];
}

/** Read-only path/type verification. No Actor IDs or values are returned. */
export interface CombatManagerStatPathValidationDto {
    path: string;
    kind: CombatManagerStatKind;
    observedActorTypes: string[];
}

export interface CombatManagerStatPreferencesDto {
    source: 'saved' | 'module' | 'none';
    attributes: CombatManagerSelectedStatDto[];
    suggestions: ModuleCombatStatAttribute[];
    available: CombatManagerAvailableStatDto[];
    /** Explicit GM override; null restores module formula, then Core fallback. */
    initiativeFormula: string | null;
    initiativePreview?: { source: 'module' | 'gm' | 'core'; formula: string; rollAvailable: boolean; advantageAvailable: boolean };
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
    multiline?: true;
    /** Only host-sanitized HTML is sent in this presentation mode. */
    contentFormat?: 'html';
    layout?: CombatManagerStatLayout;
    showInRoster?: true;
    health?: true;
    edit?: { key: string; path: string; value: number; max?: number };
}

export interface CombatManagerStatUpdateRequest {
    value: number;
    expected: { actorId: string; path: string; value: number };
}

export interface CombatManagerHealthBatchRequest {
    operation: 'damage' | 'heal';
    amount: number;
    targets: Array<{
        combatantId: string;
        statKey: string;
        expected: { actorId: string; path: string; value: number };
    }>;
}

export interface CombatManagerHealthBatchDto {
    applied: number;
    encounter: CombatManagerEncounterDto;
}

export interface CombatManagerParticipantDto {
    id: string;
    actorId: string;
    /** Native document type, distinct from the ownership-based isNpc classification. */
    actorType: string | null;
    source: 'world' | 'compendium-copy';
    /** Foundry-style NPC: no non-GM user owns the associated world Actor. */
    isNpc: boolean;
    name: string;
    img: string | null;
    initiative: number | null;
    hidden: boolean;
    defeated: boolean;
    /** Explicit Combatant flag, separate from effective Actor dead status. */
    defeatedFlag?: boolean;
    skip: boolean;
    isCurrent: boolean;
    resource: CombatManagerResourceDto | null;
    effects: string[];
    stats: CombatManagerStatDto[];
    initiativeRoll: { formula: string; source: 'module' | 'gm' | 'core'; rollAvailable: boolean; advantageAvailable: boolean };
}

export interface CombatManagerEncounterDto {
    id: string;
    label: string;
    status: 'provisioning' | 'active' | 'cleaning' | 'completed';
    keepHistory: boolean;
    deletionRequested: boolean;
    round: number;
    currentCombatantId: string | null;
    /** Manager-only pause/no-current state. Never a player hidden-turn marker. */
    awaitingInitiative?: boolean;
    canNavigateTurns?: boolean;
    pausedForSkip?: true;
    autoSkipDefeatedEnemies: boolean;
    playerActions: {
        /** Pre-start switch only; started, active encounters admit unrolled owners automatically. */
        initiativeOpen: boolean;
        endTurnEnabled: boolean;
        eligible: number;
        scored: number;
    };
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

export interface CombatManagerInitiativeResetDto {
    cleared: number;
    encounter: CombatManagerEncounterDto;
}
