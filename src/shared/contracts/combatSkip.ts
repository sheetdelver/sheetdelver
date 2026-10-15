/** Core-owned per-Combatant managed queue flag; not an Actor condition. */
export const COMBAT_SKIP_FLAG_PATH = 'flags.world.sheetDelverSkip';

/** Missing/false is legacy inclusion; malformed explicit values fail closed. */
export function readCombatSkip(flags: unknown): boolean {
    if (!flags || typeof flags !== 'object' || Array.isArray(flags)) return false;
    const world = (flags as Record<string, unknown>).world;
    if (!world || typeof world !== 'object' || Array.isArray(world)) return false;
    if (!Object.prototype.hasOwnProperty.call(world, 'sheetDelverSkip')) return false;
    return (world as Record<string, unknown>).sheetDelverSkip !== false;
}
