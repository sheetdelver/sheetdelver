import { userStore } from '@server/core/documents/primary/users/UserStore';
import { isAssistantGM } from '@server/core/documents/primary/base/ownership';

export class CombatManagerError extends Error {
    constructor(message: string, public readonly status: number, public readonly code?: string) { super(message); }
}

/** Always resolve the current authoritative role, including after async reads. */
export function requireCombatManagerSubject(userId: string | null | undefined) {
    const subject = userStore.createAccessSubject(userId);
    if (!subject || !isAssistantGM(subject)) throw new CombatManagerError('Gamemaster or Assistant access required', 403);
    return subject;
}
