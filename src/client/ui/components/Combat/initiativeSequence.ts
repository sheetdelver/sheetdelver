import type { CombatTrackerDto, CombatTrackerCombatantDto, CombatInitiativeSuccessPayload } from '@shared/contracts/combats';
import { ApiError } from '@client/ui/api/http';
import { ownedInitiativeCandidates } from './combatHudState';

export type InitiativeOutcome = {
    id: string;
    state: 'unattempted' | 'running' | 'applied' | 'skipped' | 'failed' | 'unknown';
    message?: string;
};

/** Runs existing single-target commands, never retries or adds new targets.
 * All authority remains at the server; refreshing only supplies observations.
 */
export async function runInitiativeSequence(targets: readonly CombatTrackerCombatantDto[], phaseGeneration: string | undefined, deps: {
    isCurrent: () => boolean;
    readCombat: () => Promise<CombatTrackerDto | null>;
    submit: (row: CombatTrackerCombatantDto) => Promise<CombatInitiativeSuccessPayload>;
    report: (outcome: InitiativeOutcome) => void;
}): Promise<void> {
    for (const target of targets.map(row => ({ id: row.id, actorId: row.actorId }))) {
        if (!deps.isCurrent()) return;
        let combat: CombatTrackerDto | null;
        try { combat = await deps.readCombat(); }
        catch {
            if (deps.isCurrent()) deps.report({ id: target.id, state: 'failed', message: 'Could not refresh eligibility. No roll sent.' });
            return;
        }
        if (!deps.isCurrent()) return;
        if (!combat || combat.playerInitiative?.generation !== phaseGeneration) return;
        const row = ownedInitiativeCandidates(combat).find(row => row.id === target.id && row.actorId === target.actorId);
        if (!row || !row.initiativeRoll?.rollAvailable) {
            deps.report({ id: target.id, state: 'skipped', message: 'No longer eligible, target changed, or individual input required.' });
            continue;
        }
        deps.report({ id: target.id, state: 'running' });
        try {
            const result = await deps.submit(row);
            if (!deps.isCurrent()) return;
            deps.report({ id: target.id, state: 'applied', message: `Initiative ${result.initiative}` });
        } catch (error) {
            if (!deps.isCurrent()) return;
            const code = error instanceof ApiError ? error.code : undefined;
            const state = code === 'TURN_SYNC_UNKNOWN' ? 'applied'
                : code === 'ROLL_OUTCOME_UNKNOWN' || !(error instanceof ApiError)
                    || (error.status >= 500 && code !== 'ROLL_NOT_APPLIED') ? 'unknown' : 'failed';
            deps.report({ id: target.id, state, message: error instanceof Error ? error.message : 'Refresh and inspect chat before retrying.' });
            return;
        }
    }
}
