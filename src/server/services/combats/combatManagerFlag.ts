import type { CombatDocument } from '@server/shared/types/documents';

export interface CombatManagerFlag {
    schemaVersion: 1;
    mode: 'tokenless';
    label: string;
    status: 'provisioning' | 'active' | 'cleaning' | 'completed';
    keepHistory: boolean;
    folderId: string | null;
    copyIds: string[];
    /** Assign the explicit Skip flag on SheetDelver NPC Defeated actions only. */
    autoSkipDefeatedEnemies?: boolean;
    /** Last allocated Combatant label number per source pack UUID. */
    copyNameCounters?: Record<string, number>;
    /** GM-authored participation policy; absent settings retain safe legacy defaults. */
    playerActions?: {
        initiativeOpen: boolean;
        initiativeGeneration: string;
        endTurnEnabled: boolean;
    };
    /** Restart-safe navigation anchor when a GM clears the active score. */
    turnPause?: { combatantId: string; initiative: number; reason?: 'initiative' | 'skip' } | null;
    completedAt?: string;
    /** Set before explicit deletion, including an uncompleted encounter. */
    deletionRequested?: true;
    /** Legacy A2 history-cleanup marker; read only so older flags can retry safely. */
    historyRemovalRequested?: true;
}

/** A malformed marked encounter must never fall through to ordinary Combat permissions. */
export function hasCombatManagerMarker(combat: CombatDocument | null | undefined): boolean {
    const world = combat?.flags?.world;
    return !!world && typeof world === 'object' && !Array.isArray(world)
        && Object.prototype.hasOwnProperty.call(world, 'sheetDelverCombat');
}

export function playerActionsFor(flag: CombatManagerFlag) {
    return flag.playerActions ?? { initiativeOpen: false, initiativeGeneration: '', endTurnEnabled: true };
}

/** Effective owner-roll window. Started encounters admit unrolled owners automatically. */
export function playerInitiativeGeneration(combat: { round?: number; active?: boolean }, flag: CombatManagerFlag): string | null {
    if (flag.status !== 'active' || flag.deletionRequested || flag.historyRemovalRequested) return null;
    const actions = playerActionsFor(flag);
    if ((combat.round ?? 0) > 0) return combat.active ? `active:${actions.initiativeGeneration}` : null;
    return actions.initiativeOpen ? actions.initiativeGeneration : null;
}

export function readCombatManagerFlag(combat: CombatDocument | null | undefined): CombatManagerFlag | null {
    if (!combat || combat.scene !== null) return null;
    const world = combat.flags?.world;
    if (!world || typeof world !== 'object' || Array.isArray(world)) return null;
    const value = (world as Record<string, unknown>).sheetDelverCombat;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const flag = value as Record<string, unknown>;
    if (flag.schemaVersion !== 1 || flag.mode !== 'tokenless'
        || typeof flag.label !== 'string' || typeof flag.keepHistory !== 'boolean'
        || !['provisioning', 'active', 'cleaning', 'completed'].includes(String(flag.status))
        || !(flag.folderId === null || typeof flag.folderId === 'string')
        || !Array.isArray(flag.copyIds) || !flag.copyIds.every(id => typeof id === 'string')) return null;
    if (flag.copyNameCounters !== undefined && (typeof flag.copyNameCounters !== 'object'
        || flag.copyNameCounters === null || Array.isArray(flag.copyNameCounters)
        || Object.values(flag.copyNameCounters).some(value => !Number.isSafeInteger(value) || (value as number) < 1))) return null;
    if (flag.historyRemovalRequested !== undefined && flag.historyRemovalRequested !== true) return null;
    if (flag.deletionRequested !== undefined && flag.deletionRequested !== true) return null;
    if (flag.autoSkipDefeatedEnemies !== undefined && typeof flag.autoSkipDefeatedEnemies !== 'boolean') return null;
    if (flag.turnPause !== undefined && flag.turnPause !== null) {
        const pause = flag.turnPause;
        if (!pause || typeof pause !== 'object' || Array.isArray(pause)) return null;
        const anchor = pause as Record<string, unknown>;
        if (typeof anchor.combatantId !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(anchor.combatantId)
            || typeof anchor.initiative !== 'number' || !Number.isFinite(anchor.initiative)) return null;
        if (anchor.reason !== undefined && anchor.reason !== 'initiative' && anchor.reason !== 'skip') return null;
    }
    if (flag.playerActions !== undefined) {
        const policy = flag.playerActions;
        if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;
        const actions = policy as Record<string, unknown>;
        if (typeof actions.initiativeOpen !== 'boolean' || typeof actions.endTurnEnabled !== 'boolean'
            || typeof actions.initiativeGeneration !== 'string' || actions.initiativeGeneration.length > 128
            || (actions.initiativeOpen && !actions.initiativeGeneration)) return null;
    }
    return flag as unknown as CombatManagerFlag;
}
