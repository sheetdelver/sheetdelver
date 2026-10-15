/** Serialize Core-originated writes for one encounter. Native Foundry writes
 * remain outside this best-effort guard and are checked again via observations. */
const busy = new Set<string>();

export class EncounterBusyError extends Error {
    readonly status = 409;
    readonly code = 'ENCOUNTER_BUSY';
    constructor() { super('Encounter has another pending change'); }
}

export async function withEncounterLock<T>(combatId: string, operation: () => Promise<T>): Promise<T> {
    if (busy.has(combatId)) throw new EncounterBusyError();
    busy.add(combatId);
    try { return await operation(); } finally { busy.delete(combatId); }
}
