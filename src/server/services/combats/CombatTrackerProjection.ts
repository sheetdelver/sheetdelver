import type {
    PreparedEncounter,
    PreparedEncounterRow,
} from '@server/core/documents/encounters/CombatEncounterReadModel';
import {
    isAssistantGM,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import type { CombatTrackerDto, CombatTrackerCombatantDto } from '@shared/contracts/combats';

export interface CombatTrackerProjectionDeps {
    /**
     * OWNER-threshold actor check (ADR-0013: `canReadActor(..., WRITEABLE)`).
     * Drives `canRollInitiative` and non-GM `canAdvanceTurn`.
     */
    canWriteActor(actorId: string, subject: DocumentAccessSubject): boolean;
}

/**
 * Subject-specific tracker projection (ADR-0028 §5, Phase 4).
 *
 * Accepts a prepared encounter (user-invariant, hidden rows included) and the
 * requesting subject, and returns the whitelisted `CombatTrackerDto`:
 *
 *   - Hidden rows are pruned for non-GM viewers *after* current-turn identity
 *     was resolved against the full order, so redaction can never shift the
 *     highlight onto the wrong row (audit CMB-01).
 *   - A hidden current combatant is never identified to a viewer who cannot
 *     see it: `currentCombatantId` nulls out and
 *     `hasHiddenCurrentCombatant` is set instead.
 *   - Capabilities are server-computed. Non-GMs can advance only when the
 *     current combatant is visible to them and they own its actor; starting
 *     an unstarted encounter and rewinding are GM-only.
 *   - `actor` roll payloads are attached by the service, not here — this
 *     builder stays synchronous and store-agnostic.
 */
export function buildCombatTrackerDto(
    prepared: PreparedEncounter,
    subject: DocumentAccessSubject,
    deps: CombatTrackerProjectionDeps,
): CombatTrackerDto {
    const gm = isAssistantGM(subject);
    let rows = gm ? prepared.rows : prepared.rows.filter(row => !row.hidden);

    // Pre-combat redaction (ADR-0028 QoL addendum): an unstarted encounter
    // exposes to a non-GM only the rows they can roll initiative for, so
    // players can pre-roll without the forming roster being revealed. The
    // full (redacted) tracker appears once the encounter starts.
    if (!prepared.started && !gm) {
        rows = rows.filter(row => row.actorId !== null && deps.canWriteActor(row.actorId, subject));
    }

    const currentRow = prepared.currentCombatantId
        ? prepared.rows.find(row => row.id === prepared.currentCombatantId) ?? null
        : null;
    const currentHiddenForSubject = !gm && currentRow?.hidden === true;
    const currentCombatantId = currentHiddenForSubject ? null : prepared.currentCombatantId;

    const canWriteRow = (row: PreparedEncounterRow): boolean => {
        if (gm) return true;
        if (!row.actorId) return false;
        return deps.canWriteActor(row.actorId, subject);
    };

    // Advancing requires owning the visible current combatant; starting an
    // unstarted encounter (no current combatant yet) is a GM action.
    const canAdvanceTurn = gm || (
        currentRow !== null && !currentHiddenForSubject && canWriteRow(currentRow)
    );
    const canRewindTurn = gm && prepared.started;

    const combatants: CombatTrackerCombatantDto[] = rows.map(row => ({
        id: row.id,
        actorId: row.actorId,
        name: row.name,
        img: row.img,
        initiative: row.initiative,
        defeated: row.defeated,
        hidden: row.hidden,
        isCurrent: currentCombatantId !== null && row.id === currentCombatantId,
        canRollInitiative: canWriteRow(row),
        actor: null,
    }));

    return {
        id: prepared.id,
        active: prepared.active,
        started: prepared.started,
        round: prepared.round,
        currentCombatantId,
        hasHiddenCurrentCombatant: currentHiddenForSubject,
        canAdvanceTurn,
        canRewindTurn,
        combatants,
    };
}
