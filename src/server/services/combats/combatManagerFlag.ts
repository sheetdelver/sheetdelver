import type { CombatDocument } from '@server/shared/types/documents';

export interface CombatManagerFlag {
    schemaVersion: 1;
    mode: 'tokenless';
    label: string;
    status: 'provisioning' | 'active' | 'cleaning' | 'completed';
    keepHistory: boolean;
    folderId: string | null;
    copyIds: string[];
    /** Last allocated Combatant label number per source pack UUID. */
    copyNameCounters?: Record<string, number>;
    completedAt?: string;
    /** Set before explicit deletion, including an uncompleted encounter. */
    deletionRequested?: true;
    /** Legacy A2 history-cleanup marker; read only so older flags can retry safely. */
    historyRemovalRequested?: true;
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
    return flag as unknown as CombatManagerFlag;
}
