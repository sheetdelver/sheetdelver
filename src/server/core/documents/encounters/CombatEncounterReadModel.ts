import { EventEmitter } from 'node:events';
import type {
    CombatDocument,
    CombatantDocument,
    CombatantGroupDocument,
} from '@server/shared/types/documents';
import {
    cloneDocument,
    getDocumentId,
    type DocumentChangedEvent,
    type DocumentListInvalidatedEvent,
} from '../primary/base/PrimaryDocumentStore';
import { combatStore, type CombatStore } from '../primary/combats/CombatStore';
import { actorStore, type ActorStore } from '../primary/actors/ActorStore';

/**
 * One prepared tracker row. User-invariant: hidden rows are present with
 * their `hidden` flag set — per-subject redaction happens in the projection
 * layer (ADR-0028 §4/§5), never here.
 */
export interface PreparedEncounterRow {
    id: string;
    actorId: string | null;
    tokenId: string | null;
    name: string | null;
    img: string | null;
    initiative: number | null;
    hidden: boolean;
    defeated: boolean;
    groupId: string | null;
}

export interface PreparedEncounterGroup {
    id: string;
    name: string | null;
    img: string | null;
    initiative: number | null;
}

/**
 * Prepared, user-invariant encounter state derived from one raw Combat
 * document — the backend equivalent of the state Foundry's client-side
 * Combat document derives before its tracker renders (`turns`, `combatant`,
 * `started`).
 */
export interface PreparedEncounter {
    id: string;
    active: boolean;
    /** Foundry semantics: `Combat#started` is `round > 0`. */
    started: boolean;
    round: number;
    turn: number | null;
    /**
     * Stable identity of the combatant whose turn it is, resolved against the
     * full prepared order before any redaction. Null when the encounter has
     * not started (`turn: null`) or the raw index does not resolve to a row.
     */
    currentCombatantId: string | null;
    /** Full prepared turn order (Foundry `_sortCombatants` semantics). */
    rows: PreparedEncounterRow[];
    groups: PreparedEncounterGroup[];
}

export interface EncounterChangedEvent {
    combatId: string;
    action: 'rebuild' | 'delete';
}

function isNumericInitiative(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Foundry v13 `Combat#_sortCombatants`: descending initiative, non-numeric
 * initiative sorts last, ties broken by ascending combatant id.
 */
function sortPreparedRows(a: PreparedEncounterRow, b: PreparedEncounterRow): number {
    const ia = isNumericInitiative(a.initiative) ? a.initiative : -Infinity;
    const ib = isNumericInitiative(b.initiative) ? b.initiative : -Infinity;
    return (ib - ia) || (a.id > b.id ? 1 : -1);
}

/**
 * Event-maintained Combat Encounter read model (ADR-0028 §4, Phase 3).
 *
 * Keyed by Combat id and rebuilt from `CombatStore` document events; never
 * polled and never request-time-computed. Owns the user-invariant prepared
 * state (ordering, current-combatant identity, started state, group rows,
 * display identity with actor fallback). It does not own per-subject
 * redaction, authorization, or capability flags — those belong to the
 * tracker projection (Phase 4) — and it never mutates raw documents.
 *
 * Event wiring (bound once at module init by the coordinator):
 *   - Combat `documentChanged` create/update → rebuild that encounter.
 *   - Combat `documentChanged` delete → remove that encounter.
 *   - Combat `documentListInvalidated` with a document id → rebuild, covering
 *     actor-driven identity/visibility-source changes bridged into
 *     CombatStore (actor deletes arrive only on this path).
 *
 * Actor document *updates* already surface as Combat `documentChanged` via
 * `CombatStore.bindActorVisibilityBridge`, so no direct ActorStore
 * subscription is needed; ActorStore is consulted only for display-identity
 * fallback at build time. Token-derived identity and tracker settings are
 * deliberately absent until ADR-0028 Phase 7.
 *
 * Emission rule: `encounterChanged` fires only after the prepared state is
 * current, and never during bulk seeding (mirrors ADR-0012's seeding rule).
 */
export class CombatEncounterReadModel extends EventEmitter {
    private encounters = new Map<string, PreparedEncounter>();
    private combatStore: CombatStore | null = null;
    private actorStore: ActorStore | null = null;

    public bind(combatStore: CombatStore, actorStore: ActorStore): void {
        // Idempotent for the same store pair so module-scope self-binding and
        // coordinator wiring can't stack duplicate subscriptions.
        if (this.combatStore === combatStore && this.actorStore === actorStore) return;
        this.combatStore = combatStore;
        this.actorStore = actorStore;
        combatStore.on('documentChanged', (event: DocumentChangedEvent) => {
            if (event.action === 'delete') this.remove(event.id);
            else this.rebuild(event.id);
        });
        combatStore.on('documentListInvalidated', (event: DocumentListInvalidatedEvent) => {
            if (event.documentId) this.rebuild(event.documentId);
        });
    }

    /**
     * Bulk build from the bound CombatStore. Called by the coordinator after
     * bootstrap seeding; silent (no events) like store seeding.
     */
    public rebuildAll(): void {
        this.encounters.clear();
        if (!this.combatStore) return;
        for (const combat of this.combatStore.list()) {
            const prepared = this.buildEncounter(combat);
            if (prepared) this.encounters.set(prepared.id, prepared);
        }
    }

    /** Rebuild one encounter from the raw store; removes it if the combat is gone. */
    public rebuild(combatId: string): void {
        const combat = this.combatStore?.get(combatId) ?? null;
        if (!combat) {
            this.remove(combatId);
            return;
        }
        const prepared = this.buildEncounter(combat);
        if (!prepared) return;
        this.encounters.set(prepared.id, prepared);
        this.emitChanged(prepared.id, 'rebuild');
    }

    public remove(combatId: string): void {
        if (!this.encounters.delete(combatId)) return;
        this.emitChanged(combatId, 'delete');
    }

    public clear(_reason?: string): void {
        this.encounters.clear();
    }

    public get(combatId: string): PreparedEncounter | null {
        const encounter = this.encounters.get(combatId);
        return encounter ? cloneDocument(encounter) : null;
    }

    /**
     * Read-path self-heal: return the prepared encounter, silently building it
     * from the raw store on a miss (no `encounterChanged` — nothing changed,
     * the model was just cold, e.g. a store seeded outside the coordinator's
     * bootstrap path). Event-driven maintenance remains the primary mechanism.
     */
    public getOrRebuild(combatId: string): PreparedEncounter | null {
        const cached = this.encounters.get(combatId);
        if (cached) return cloneDocument(cached);
        const combat = this.combatStore?.get(combatId) ?? null;
        if (!combat) return null;
        const prepared = this.buildEncounter(combat);
        if (!prepared) return null;
        this.encounters.set(prepared.id, prepared);
        return cloneDocument(prepared);
    }

    public list(): PreparedEncounter[] {
        return Array.from(this.encounters.values()).map(cloneDocument);
    }

    public isReady(): boolean {
        return this.combatStore?.isReady() ?? false;
    }

    private emitChanged(combatId: string, action: EncounterChangedEvent['action']): void {
        const event: EncounterChangedEvent = { combatId, action };
        this.emit('encounterChanged', event);
    }

    private buildEncounter(combat: CombatDocument): PreparedEncounter | null {
        const combatId = getDocumentId(combat);
        if (!combatId) return null;

        const rows = (combat.combatants || [])
            .map(combatant => this.buildRow(combatant))
            .filter((row): row is PreparedEncounterRow => row !== null)
            .sort(sortPreparedRows);

        const round = combat.round ?? 0;
        const turn = combat.turn ?? null;
        const currentCombatantId = turn !== null && turn >= 0 && turn < rows.length
            ? rows[turn].id
            : null;

        return {
            id: combatId,
            active: combat.active === true,
            started: round > 0,
            round,
            turn,
            currentCombatantId,
            rows,
            groups: (combat.groups || [])
                .map(group => this.buildGroup(group))
                .filter((group): group is PreparedEncounterGroup => group !== null),
        };
    }

    private buildRow(combatant: CombatantDocument): PreparedEncounterRow | null {
        const id = getDocumentId(combatant);
        if (!id) return null;

        // Display identity: combatant fields first, raw actor fallback
        // (token fallback is Phase 7). ActorStore access is privileged here —
        // the prepared row is user-invariant and redaction happens later.
        const actor = combatant.actorId ? this.actorStore?.get(combatant.actorId) ?? null : null;
        const actorName = typeof actor?.name === 'string' ? actor.name : null;
        const actorImg = typeof actor?.img === 'string' ? actor.img : null;

        return {
            id,
            actorId: combatant.actorId ?? null,
            tokenId: combatant.tokenId ?? null,
            name: combatant.name ?? actorName,
            img: combatant.img ?? actorImg,
            initiative: isNumericInitiative(combatant.initiative) ? combatant.initiative : null,
            hidden: combatant.hidden === true,
            defeated: combatant.defeated === true,
            groupId: combatant.group ?? null,
        };
    }

    private buildGroup(group: CombatantGroupDocument): PreparedEncounterGroup | null {
        const id = getDocumentId(group);
        if (!id) return null;
        return {
            id,
            name: group.name ?? null,
            img: group.img ?? null,
            initiative: isNumericInitiative(group.initiative) ? group.initiative : null,
        };
    }
}

export const combatEncounterReadModel = new CombatEncounterReadModel();

// Self-bind the singleton to the singleton stores at module load so every
// import path (coordinator bootstrap, route services, standalone tests) sees
// a bound model; `bind` is idempotent for this pair.
combatEncounterReadModel.bind(combatStore, actorStore);
