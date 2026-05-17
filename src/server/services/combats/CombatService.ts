import { logger } from '@shared/utils/logger';
import { getAdapter } from '@modules/registry/server';
import type { RawActor } from '@server/shared/types/actors';
import type { CombatClientLike, RawCombat, RawCombatant } from '@server/shared/types/documents';
import { FoundryUserRole } from '@server/core/documents/primary/base/ownership';
import { combatStore } from '@server/core/documents/primary/combats/CombatStore';
import { PrimaryDocumentCacheNotReadyError } from '@server/core/documents/primary/errors';
import { CombatRepository } from '@server/core/documents/primary/combats/CombatRepository';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import type {
    CombatDto,
    CombatListPayload,
    CombatTurnSuccessPayload,
    CombatInitiativeSuccessPayload,
    CombatErrorPayload,
} from '@shared/contracts/combats';

interface InitiativeBody {
    formula?: string;
    advantageMode?: 'advantage' | 'disadvantage' | 'normal' | string;
}

interface CombatProjection extends CombatDto {
    combatants?: Array<RawCombatant & { actor: RawActor | null }>;
}

interface AdapterWithInitiativeFormula {
    getInitiativeFormula?: (actor: RawActor) => string;
}

interface CombatServiceDeps {
    normalizeActors: (actorList: RawActor[], client: CombatClientLike) => Promise<RawActor[]>;
}

export function sortCombatants(combatants: RawCombatant[] = []): RawCombatant[] {
    return [...combatants].sort((a, b) => {
        const ia = typeof a.initiative === 'number' && !isNaN(a.initiative) ? a.initiative : -Infinity;
        const ib = typeof b.initiative === 'number' && !isNaN(b.initiative) ? b.initiative : -Infinity;
        const aid = String(a._id || a.id || '');
        const bid = String(b._id || b.id || '');
        return (ib - ia) || (aid > bid ? 1 : -1);
    });
}

function isGmLike(userId: string | null | undefined): boolean {
    return !!userId && userStore.getRole(userId) >= FoundryUserRole.ASSISTANT;
}

export function createCombatService(deps: CombatServiceDeps) {
    const createCombatRepository = (client: CombatClientLike): CombatRepository => new CombatRepository({
        dispatchDocument: (
            type: string,
            action: string,
            operation?: unknown,
            parent?: { type: string; id: string },
        ) => client.dispatchDocument(type, action, operation, parent),
    });

    const ensureReady = (): void => {
        if (!combatStore.isReady()) throw new PrimaryDocumentCacheNotReadyError('Combat');
    };

    // Combat list projection with enriched/normalized combatant actor payloads.
    // Non-GM subjects see only combats they can read; hidden combatants are
    // pruned from non-GM views at the DTO boundary. Non-hidden combatants in a
    // visible combat surface the actor's name + img even when the player can't
    // read the actor doc itself — matches Foundry's tracker, which uses the
    // token/actor displayed name for tracker rows regardless of actor ownership.
    // Sensitive fields (`system`, `items`, `ownership`, etc.) stay stripped for
    // non-readable actors.
    const listCombats = async (client: CombatClientLike): Promise<CombatListPayload> => {
        ensureReady();
        const subject = userStore.createAccessSubject(client.userId);
        const userIsGm = isGmLike(client.userId);

        const visible = subject ? combatStore.list({ subject }) : [];

        const enrichedCombats = await Promise.all(visible.map(async (combat): Promise<CombatProjection> => {
            const combatants = userIsGm
                ? (combat.combatants || [])
                : (combat.combatants || []).filter(c => !c.hidden);

            const actorIds = [...new Set(combatants.map((c) => c.actorId).filter(Boolean) as string[])];
            // Two-track collection: readable actors flow through normalize as
            // before; non-readable actors yield a stripped name/img fallback so
            // the tracker has something to render.
            const readableActors: Record<string, RawActor> = {};
            const strippedActors: Record<string, RawActor> = {};

            await Promise.all(actorIds.map(async (id) => {
                try {
                    const actor = await client.getActor(id);
                    if (actor) {
                        readableActors[id] = actor;
                        return;
                    }
                    const raw = await client.getActorRaw(id);
                    if (raw) {
                        // Resolve `img` against the Foundry URL prefix so browser
                        // requests don't 404 on the raw relative path. The
                        // readable path picks this up through `normalizeActors`;
                        // the stripped path does it inline because the system
                        // adapter doesn't see these projections.
                        const resolvedImg = typeof raw.img === 'string'
                            ? client.resolveUrl(raw.img)
                            : raw.img;
                        strippedActors[id] = {
                            _id: raw._id,
                            id: raw.id,
                            name: raw.name,
                            img: resolvedImg,
                        } as RawActor;
                    }
                } catch {
                    logger.error(`Failed to fetch actor ${id} for combat ${combat._id}`);
                }
            }));

            const actorsToNormalize = Object.values(readableActors).filter(Boolean);
            const normalizedActors = await deps.normalizeActors(actorsToNormalize, client);
            const displayMap: Record<string, RawActor> = { ...strippedActors };
            normalizedActors.forEach((a) => {
                const id = a._id || a.id;
                if (id) displayMap[id] = a;
            });

            const enrichedCombatants = combatants.map((c) => ({
                ...c,
                actor: c.actorId ? (displayMap[c.actorId] || null) : null
            }));

            return { ...combat, combatants: enrichedCombatants };
        }));

        return { success: true, combats: enrichedCombats };
    };

    // Authorization helper for turn advancement rules.
    const isAuthorizedForCombatTurn = async (client: CombatClientLike, combat: RawCombat, userId: string): Promise<boolean> => {
        if (isGmLike(userId)) return true;

        const currentTurn = combat.turn ?? 0;
        const sortedCombatants = sortCombatants(combat.combatants || []);

        const activeCombatant = sortedCombatants[currentTurn];
        if (!activeCombatant || !activeCombatant.actorId) return false;

        const actor = await client.getActor(activeCombatant.actorId);
        if (!actor) return false;

        const ownership = actor.ownership?.[userId] || 0;
        return ownership >= 3;
    };

    // Turn advancement logic mirroring Foundry round/turn progression.
    const advanceTurn = async (
        client: CombatClientLike,
        combatId: string
    ): Promise<CombatTurnSuccessPayload | CombatErrorPayload> => {
        ensureReady();
        const combat = combatStore.get(combatId);

        if (!combat) {
            return { error: 'Combat not found', status: 404 };
        }

        if (!client.userId || !(await isAuthorizedForCombatTurn(client, combat, client.userId))) {
            return { error: 'Unauthorized: You do not own the current combatant and are not a GM', status: 403 };
        }

        const sortedCombatants = sortCombatants(combat.combatants || []);

        let currentRound = combat.round || 0;
        let currentTurn = combat.turn ?? -1;

        if (currentRound === 0) {
            currentRound = 1;
            currentTurn = 0;
        } else {
            currentTurn += 1;
            if (currentTurn >= sortedCombatants.length) {
                currentRound += 1;
                currentTurn = 0;
            }
        }

        await createCombatRepository(client).update(combatId, { round: currentRound, turn: currentTurn });

        return { success: true, round: currentRound, turn: currentTurn };
    };

    // Turn rewind logic gated to GM access only.
    const previousTurn = async (
        client: CombatClientLike,
        combatId: string
    ): Promise<CombatTurnSuccessPayload | CombatErrorPayload> => {
        ensureReady();
        const combat = combatStore.get(combatId);

        if (!combat) {
            return { error: 'Combat not found', status: 404 };
        }

        if (!isGmLike(client.userId)) {
            return { error: 'Unauthorized: Only GMs can move to previous turns', status: 403 };
        }

        const sortedCombatants = sortCombatants(combat.combatants || []);

        let currentRound = combat.round || 0;
        let currentTurn = combat.turn ?? 0;

        if (currentRound === 0) {
            // Do nothing if not started.
        } else if (currentTurn === 0) {
            if (currentRound > 1) {
                currentRound -= 1;
                currentTurn = Math.max(0, sortedCombatants.length - 1);
            } else {
                currentRound = 0;
                currentTurn = 0;
            }
        } else {
            currentTurn -= 1;
        }

        await createCombatRepository(client).update(combatId, { round: currentRound, turn: currentTurn });

        return { success: true, round: currentRound, turn: currentTurn };
    };

    // Initiative roll orchestration with adapter initiative formula fallback.
    const rollInitiative = async (
        client: CombatClientLike,
        combatId: string,
        combatantId: string,
        body: InitiativeBody
    ): Promise<CombatInitiativeSuccessPayload | CombatErrorPayload> => {
        ensureReady();
        const { formula, advantageMode } = body;

        const systemInfo = await client.getSystem();
        const adapter = await getAdapter(systemInfo.id.toLowerCase());
        if (!adapter) throw new Error(`Adapter ${systemInfo.id} not found`);

        const combat = combatStore.get(combatId);
        if (!combat) return { error: 'Combat not found', status: 404 };

        const combatant = combat.combatants?.find((c) => (c._id || c.id) === combatantId);
        if (!combatant) return { error: 'Combatant not found', status: 404 };
        if (!combatant.actorId) return { error: 'Actor not found', status: 404 };

        const actor = await client.getActor(combatant.actorId);
        if (!actor) return { error: 'Actor not found', status: 404 };

        let finalFormula = formula;
        if (!finalFormula) {
            const initiativeAdapter = adapter as AdapterWithInitiativeFormula;
            if (typeof initiativeAdapter.getInitiativeFormula === 'function') {
                finalFormula = initiativeAdapter.getInitiativeFormula(actor);
            } else {
                finalFormula = '1d20';
            }
        }

        if (advantageMode === 'advantage') {
            finalFormula = finalFormula.replace(/^(?:1d20|2d20k[hl]1)/i, '2d20kh1');
        } else if (advantageMode === 'disadvantage') {
            finalFormula = finalFormula.replace(/^(?:1d20|2d20k[hl]1)/i, '2d20kl1');
        } else if (advantageMode === 'normal') {
            finalFormula = finalFormula.replace(/^(?:2d20k[hl]1)/i, '1d20');
        }

        const speaker = {
            actor: actor._id || actor.id,
            alias: actor.name
        };

        const chatMessage = await client.roll(finalFormula, 'Initiative', { speaker });
        const total = parseInt(String(chatMessage.content));

        if (isNaN(total)) {
            throw new Error('Failed to parse roll total from chat message');
        }

        await createCombatRepository(client).updateCombatant(combatId, combatantId, { initiative: total });

        return { success: true, initiative: total };
    };

    return {
        listCombats,
        advanceTurn,
        previousTurn,
        rollInitiative
    };
}
