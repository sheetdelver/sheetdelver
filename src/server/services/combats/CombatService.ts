import { logger } from '@shared/utils/logger';
import { getAdapter } from '@modules/registry/server';
import type { CombatClientLike, RollChatMessageLike } from '@server/shared/types/documents';
import {
    DOCUMENT_VISIBILITY,
    isAssistantGM,
    FoundryUserRole,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { combatStore } from '@server/core/documents/primary/combats/CombatStore';
import { sceneStore } from '@server/core/documents/primary/scenes/SceneStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { combatEncounterReadModel, type PreparedEncounter } from '@server/core/documents/encounters/CombatEncounterReadModel';
import { PrimaryDocumentCacheNotReadyError } from '@server/core/documents/primary/errors';
import { CombatRepository } from '@server/core/documents/primary/combats/CombatRepository';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { worldBootstrapper } from '@server/services/world/WorldBootstrapper';
import { getDocumentId } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import {
    preparedActorStore,
    PreparedActorUnavailableError,
} from '@server/core/documents/prepared/actors/PreparedActorStore';
import type { PreparedActorData, SystemAdapter } from '@shared/sdk';
import type { CombatManagerSelectedStatDto } from '@shared/contracts/combatManager';
import { buildCombatTrackerDto } from './CombatTrackerProjection';
import { hasCombatManagerMarker, playerActionsFor, playerInitiativeGeneration, readCombatManagerFlag } from './combatManagerFlag';
import { combatStatDisplayService, projectCombatStatFields } from './CombatStatDisplayService';
import { effectiveInitiativeFormula } from './CombatInitiativeFormula';
import { withEncounterLock } from './EncounterCommandGuard';
import { hasManagedInitiative, isManagedTurnEligible, managedCurrentCombatantId, resolveManagedTurn } from './CombatTurnQueue';
import type {
    CombatTrackerDto,
    CombatTrackerCombatantDto,
    CombatListPayload,
    CombatTurnSuccessPayload,
    CombatInitiativeSuccessPayload,
    CombatInitiativeRequestBody,
    CombatTurnObservation,
    CombatErrorPayload,
} from '@shared/contracts/combats';
import { applyInitiativeMode } from '@shared/contracts/initiativeMode';

interface CombatServiceDeps {
    getPreparedActor?: (actorId: string) => PreparedActorData;
}

/** Internal execution result; HTTP responses never expose the positional turn. */
type CombatTurnExecution = CombatTurnSuccessPayload & { round: number; turn: number };

function resolveSubject(userId: string | null | undefined): DocumentAccessSubject | null {
    const subject = userStore.createAccessSubject(userId);
    // A deleted/banned user can still be named in Actor ownership. That map
    // does not keep a retired caller authorized through a pending request.
    return subject && subject.role >= FoundryUserRole.PLAYER && userStore.get(subject.userId)
        ? subject : null;
}

const projectionDeps = {
    canWriteActor: (actorId: string, subject: DocumentAccessSubject) =>
        actorStore.canReadActor(actorId, subject, DOCUMENT_VISIBILITY.WRITEABLE),
};

export function getCombatInitiativeRollTotal(message: RollChatMessageLike): number {
    // Core chat content is presentation HTML. Read the evaluated Foundry Roll
    // first, retaining numeric content only for older client implementations.
    const serializedRoll = message.rolls?.[0];
    let rollTotal: unknown;
    try {
        rollTotal = typeof serializedRoll === 'string'
            ? (JSON.parse(serializedRoll) as { total?: unknown }).total
            : serializedRoll?.total;
    } catch {
        // Fall back to legacy plain numeric content below.
    }
    const total = typeof rollTotal === 'number'
        ? rollTotal
        : typeof message.content === 'string' && message.content.trim() !== ''
            ? Number(message.content)
            : Number.NaN;
    if (!Number.isFinite(total)) throw new Error('Failed to parse roll total from chat message');
    return total;
}

export function createCombatService(deps: CombatServiceDeps) {
    const getPreparedActor = deps.getPreparedActor
        ?? ((actorId: string) => preparedActorStore.getRequired(actorId));

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

    const playerScope = (client: CombatClientLike) => ({
        userId: client.userId,
        worldId: worldStateStore.getCurrentWorldId(),
        epoch: worldBootstrapper.getRuntimeEpoch(),
    });
    const samePlayerScope = (client: CombatClientLike, scope: ReturnType<typeof playerScope>): boolean =>
        !!scope.userId && !!scope.worldId && client.userId === scope.userId
        && worldStateStore.isReady() && worldStateStore.getCurrentWorldId() === scope.worldId
        && worldBootstrapper.getRuntimeEpoch() === scope.epoch
        && (client as CombatClientLike & { isConnected?: boolean }).isConnected !== false;

    /** Add bounded owned-stat/roll metadata and resolve display image paths. */
    const enrichTrackerDto = (dto: CombatTrackerDto, client: CombatClientLike,
        subject: DocumentAccessSubject, attributes: CombatManagerSelectedStatDto[],
        adapter: SystemAdapter | null, initiativeFallback: string | null): CombatTrackerDto => {
        const combat = combatStore.get(dto.id);
        const enrichRow = (row: CombatTrackerCombatantDto): CombatTrackerCombatantDto => {
                const source = row.actorId ? actorStore.get(row.actorId, { subject }) : null;
                const owned = !!row.actorId && subject.role < FoundryUserRole.ASSISTANT
                    && projectionDeps.canWriteActor(row.actorId, subject);
                const rawRow = combat?.combatants?.find(entry => (entry._id || entry.id) === row.id);
                const marker = rawRow?.flags?.world && typeof rawRow.flags.world === 'object'
                    ? (rawRow.flags.world as Record<string, unknown>).sheetDelverGeneratedName : null;
                const generated = marker && typeof marker === 'object' && !Array.isArray(marker)
                    ? marker as Record<string, unknown> : null;
                const token = rawRow?.sceneId && rawRow.tokenId
                    ? sceneStore.getToken(rawRow.sceneId, rawRow.tokenId) : null;
                const unlinked = !!token && token.actorLink === false;
                let prepared: PreparedActorData | null = null;
                if (row.actorId && (owned || row.canRollInitiative)) {
                    try { prepared = getPreparedActor(row.actorId); }
                    catch (error) {
                        if (!(error instanceof PreparedActorUnavailableError)) throw error;
                    }
                }
                const projectedStats = owned && !unlinked && prepared
                    ? projectCombatStatFields(prepared, attributes.filter(attribute => attribute.kind !== 'textarea')).map(stat => ({
                        title: stat.title, value: stat.value,
                        ...(stat.subValue !== undefined ? { subValue: stat.subValue } : {}),
                    })) : [];
                const initiative = row.canRollInitiative && prepared
                    ? effectiveInitiativeFormula(adapter, prepared, initiativeFallback) : null;
                return {
                    ...row,
                    name: subject.role < FoundryUserRole.ASSISTANT
                        && generated?.combatId === dto.id && generated.name === row.name
                        && typeof generated.baseName === 'string' && generated.baseName.length > 0
                        ? generated.baseName : row.name,
                    canRollInitiative: row.canRollInitiative && prepared !== null,
                    img: typeof row.img === 'string' ? client.resolveUrl(row.img) : row.img,
                    isOwned: owned,
                    canOpenActor: owned && source !== null,
                    statSource: owned ? unlinked ? 'unlinked-token' as const : 'world-actor' as const : null,
                    stats: projectedStats,
                    initiativeRoll: initiative,
                };
        };
        return {
            ...dto,
            combatants: dto.combatants.map(enrichRow),
            ...(dto.initiativeCandidates ? { initiativeCandidates: dto.initiativeCandidates.map(enrichRow) } : {}),
        };
    };

    // Tracker projection list (ADR-0028 Phases 4): prepared encounters from
    // the read model, redacted + capability-annotated per subject, then
    // enriched with bounded display/roll metadata. No raw documents are spread to the client.
    const listCombats = async (client: CombatClientLike): Promise<CombatListPayload> => {
        ensureReady();
        if (!client.userId) return { success: true, combats: [] };
        const scope = playerScope(client);
        const currentSubject = (): DocumentAccessSubject => {
            const subject = resolveSubject(client.userId);
            if (client.userId !== scope.userId || !subject) {
                throw Object.assign(new Error('Player session is no longer valid'), { status: 401 });
            }
            if (!samePlayerScope(client, scope)) {
                throw Object.assign(new Error('Combat view changed; refresh after reconnecting'), { status: 503 });
            }
            ensureReady();
            return subject;
        };
        // Read dependencies before the final authorization/projection pass. A
        // role, world or phase can change while the file/module lookup awaits.
        if (!combatStore.list({ subject: currentSubject() }).length) return { success: true, combats: [] };
        const preferences = await combatStatDisplayService.resolve(client);
        currentSubject();
        const systemInfo = await client.getSystem();
        currentSubject();
        const adapter = await getAdapter(systemInfo.id.toLowerCase());
        const subject = currentSubject();
        const visible = combatStore.list({ subject });
        const skipDefeated = isSkipDefeatedEnabled();
        // Projection is synchronous: there is no later await that can retain a
        // privileged subject or old Combat flag into the response.
        const combats = visible.map((combat) => {
            const combatId = getDocumentId(combat);
            if (!combatId) return null;
            const prepared = combatEncounterReadModel.getOrRebuild(combatId);
            if (!prepared) return null;
            const managerFlag = readCombatManagerFlag(combat);
            // A corrupted managed marker cannot acquire ordinary tracker capabilities.
            if (hasCombatManagerMarker(combat) && !managerFlag) return null;
            // Only the projection is filtered. Native indexes remain in the
            // shared read model and all document writes map through that order.
            const dto = buildCombatTrackerDto(managerFlag ? {
                ...prepared, currentCombatantId: managedCurrentCombatantId(prepared, managerFlag),
                rows: isAssistantGM(subject) ? prepared.rows : prepared.rows.filter(hasManagedInitiative),
            } : prepared, subject, { ...projectionDeps, skipDefeated, managedQueue: !!managerFlag });
            const actions = managerFlag ? playerActionsFor(managerFlag) : null;
            const owner = subject.role < FoundryUserRole.ASSISTANT;
            const phaseGeneration = managerFlag ? playerInitiativeGeneration(prepared, managerFlag) : null;
            const playerPhase = owner && phaseGeneration !== null;
            const candidates = playerPhase ? buildCombatTrackerDto(prepared, subject,
                { ...projectionDeps, skipDefeated }).combatants.filter(row => row.initiative === null
                    && row.actorId !== null && projectionDeps.canWriteActor(row.actorId, subject))
                .map(row => ({ ...row, isCurrent: false, canRollInitiative: true })) : [];
            const projected = managerFlag ? {
                ...dto,
                canAdvanceTurn: owner && managerFlag.status === 'active'
                    && !managerFlag.deletionRequested && !managerFlag.historyRemovalRequested
                    && !managerFlag.turnPause && actions?.endTurnEnabled === true
                    && prepared.active && prepared.started && dto.canAdvanceTurn,
                canRewindTurn: false,
                combatants: dto.combatants.map(row => ({ ...row,
                    canRollInitiative: playerPhase && row.actorId !== null && row.initiative === null
                        && projectionDeps.canWriteActor(row.actorId, subject) })),
                canManage: isAssistantGM(subject) && managerFlag.status === 'active',
                ...(playerPhase ? { initiativeCandidates: candidates } : {}),
                ...(playerPhase && (candidates.length > 0 || (prepared.round === 0
                    && dto.combatants.some(row => row.actorId && projectionDeps.canWriteActor(row.actorId, subject))))
                    ? { playerInitiative: { open: true as const, generation: phaseGeneration! } } : {}),
            } : dto;
            return enrichTrackerDto(projected, client, subject, preferences?.attributes ?? [],
                adapter, preferences?.initiativeFormula ?? null);
        });

        return { success: true, combats: combats.filter((c): c is CombatTrackerDto =>
            c !== null && (isAssistantGM(subject) || c.combatants.length > 0 || !!c.initiativeCandidates?.length)) };
    };

    /**
     * Load the prepared encounter for a combat action. Falls back to a silent
     * rebuild for cold read models; null means the combat doesn't exist.
     */
    const getPreparedEncounter = (combatId: string): PreparedEncounter | null => {
        if (!combatStore.get(combatId)) return null;
        return combatEncounterReadModel.getOrRebuild(combatId);
    };

    // Authorization for turn advancement: ASSISTANT-GM and above always; a
    // player only when the current combatant resolves (started, in range,
    // visible to them) and they OWN its actor via
    // `actorStore.canReadActor(..., WRITEABLE)` (ADR-0013 Phase 1). Starting
    // an unstarted encounter therefore requires a GM.
    const isAuthorizedForCombatTurn = (
        prepared: PreparedEncounter,
        subject: DocumentAccessSubject,
    ): boolean => {
        if (isAssistantGM(subject)) return true;
        if (!prepared.active || !prepared.started) return false;
        if (!prepared.currentCombatantId) return false;
        const current = prepared.rows.find(row => row.id === prepared.currentCombatantId);
        if (!current || current.hidden || !current.actorId) return false;
        return projectionDeps.canWriteActor(current.actorId, subject);
    };

    // Turn progression over the prepared encounter order.
    //
    // Sheet Delver command contract (ADR-0028 §6 fallback, explicit until/
    // unless a Foundry command bridge lands): round 0 starts at round 1 on
    // the first eligible combatant; the last eligible turn wraps to the next
    // round. When the world's skip-defeated tracker toggle
    // (`core.combatTrackerConfig.skipDefeated`, default off — Foundry
    // parity) is enabled, defeated rows are skipped in both directions.
    // Defeated means the combatant flag or the actor's `dead` status — never
    // unconscious/dying, so death-save turns are preserved. If every row is
    // ineligible, progression falls back to index 0 rather than looping.
    const isSkipDefeatedEnabled = (): boolean => {
        const config = settingStore.getValueByKey('core.combatTrackerConfig');
        return typeof config === 'object' && config !== null
            && (config as Record<string, unknown>).skipDefeated === true;
    };

    const matchesObservation = (prepared: PreparedEncounter, observed: CombatTurnObservation): boolean =>
        prepared.active === observed.active && prepared.started === observed.started
        && prepared.round === observed.round && prepared.currentCombatantId === observed.currentCombatantId;

    const advanceTurnCore = async (
        client: CombatClientLike,
        combatId: string,
        managerCommand = false,
        observed?: CombatTurnObservation,
    ): Promise<CombatTurnExecution | CombatErrorPayload> => {
        ensureReady();
        const scope = playerScope(client);
        const prepared = getPreparedEncounter(combatId);
        if (!prepared) {
            return { error: 'Combat not found', status: 404 };
        }
        const subject = resolveSubject(client.userId);
        const sourceCombat = combatStore.get(combatId);
        const managed = readCombatManagerFlag(sourceCombat);
        if (hasCombatManagerMarker(sourceCombat) && !managed) return { error: 'Encounter unavailable', status: 409 };
        if (managed && managed.status !== 'active') return { error: 'Encounter is not active', status: 409 };
        if (managed && (managed.deletionRequested || managed.historyRemovalRequested)) return { error: 'Encounter is closing', status: 409 };
        if (managed && managerCommand && (!subject || !isAssistantGM(subject))) return { error: 'Gamemaster or Assistant access required', status: 403 };
        if (managed && !managerCommand && subject && isAssistantGM(subject)) {
            return { error: 'Use the GM Combat Manager to advance this encounter', status: 403 };
        }
        if (managed && !managerCommand && (!subject || isAssistantGM(subject)
            || managed.turnPause || !playerActionsFor(managed).endTurnEnabled
            || !managedCurrentCombatantId(prepared, managed))) return { error: 'End my turn is unavailable', status: 403 };
        if (!subject || !isAuthorizedForCombatTurn(prepared, subject)) {
            return { error: 'Unauthorized: You do not own the current combatant and are not a GM', status: 403 };
        }
        if (managed && !managerCommand && !observed) return { error: 'Observed encounter state required', status: 400 };
        if (observed && !matchesObservation(prepared, observed)) {
            return { error: 'Encounter changed; review the current turn before retrying', status: 409 };
        }

        const skipDefeated = isSkipDefeatedEnabled();
        const managedTurn = managed ? resolveManagedTurn(prepared, managed, 'next') : null;
        if (managed && !managedTurn) return { error: 'No eligible scored, unskipped combatants', status: 409 };
        const eligible = (row: PreparedEncounter['rows'][number]): boolean =>
            !skipDefeated || !row.defeated;
        const firstEligibleIndex = (): number => {
            const index = prepared.rows.findIndex(eligible);
            return index >= 0 ? index : 0;
        };

        let round = prepared.round;
        let turn = prepared.turn ?? -1;

        if (managedTurn) {
            round = managedTurn.round;
            turn = managedTurn.turn!;
        } else if (round === 0) {
            round = 1;
            turn = firstEligibleIndex();
        } else {
            const next = prepared.rows.findIndex((row, index) => index > turn && eligible(row));
            if (next >= 0) {
                turn = next;
            } else {
                round += 1;
                turn = firstEligibleIndex();
            }
        }

        // Recheck policy and ownership directly before the only remote write.
        if (managed && !managerCommand) {
            const live = combatStore.get(combatId);
            const livePrepared = getPreparedEncounter(combatId);
            const liveFlag = readCombatManagerFlag(live);
            const liveSubject = resolveSubject(client.userId);
            if (!livePrepared || !liveFlag || liveFlag.status !== 'active' || liveFlag.deletionRequested
                || liveFlag.historyRemovalRequested || liveFlag.turnPause || !playerActionsFor(liveFlag).endTurnEnabled
                || !managedCurrentCombatantId(livePrepared, liveFlag)
                || !samePlayerScope(client, scope)
                || !liveSubject || isAssistantGM(liveSubject) || !isAuthorizedForCombatTurn(livePrepared, liveSubject)
                || !observed || !matchesObservation(livePrepared, observed)) {
                return { error: 'Encounter changed; review the current turn before retrying', status: 409 };
            }
        }
        const nextFlag = managed ? { ...managed } : null;
        if (nextFlag) {
            nextFlag.turnPause = null;
            if (prepared.round === 0) {
                nextFlag.playerActions = { ...playerActionsFor(nextFlag), initiativeOpen: false,
                    initiativeGeneration: crypto.randomUUID() };
            }
        }
        await createCombatRepository(client).update(combatId, {
            round, turn,
            ...(managed && managerCommand && prepared.round === 0 ? { active: true } : {}),
            ...(nextFlag && managerCommand && (managed?.turnPause || prepared.round === 0)
                ? { 'flags.world.sheetDelverCombat': nextFlag } : {}),
        });

        return { success: true, round, turn };
    };

    // Turn rewind, GM/Assistant only. Rewinding past round 1 turn 0 returns the
    // encounter to its unstarted round-zero state.
    const advanceTurn = (client: CombatClientLike, combatId: string, managerCommand = false,
        observed?: CombatTurnObservation): Promise<CombatTurnExecution | CombatErrorPayload> =>
        managerCommand ? advanceTurnCore(client, combatId, true, observed)
            : withEncounterLock(combatId, () => advanceTurnCore(client, combatId, false, observed));

    const previousTurnCore = async (
        client: CombatClientLike,
        combatId: string,
        managerCommand = false,
        observed?: CombatTurnObservation,
    ): Promise<CombatTurnExecution | CombatErrorPayload> => {
        ensureReady();
        const prepared = getPreparedEncounter(combatId);
        if (!prepared) {
            return { error: 'Combat not found', status: 404 };
        }
        const subject = resolveSubject(client.userId);
        const sourceCombat = combatStore.get(combatId);
        const managed = readCombatManagerFlag(sourceCombat);
        if (hasCombatManagerMarker(sourceCombat) && !managed) return { error: 'Encounter unavailable', status: 409 };
        if (managed && (!subject || !isAssistantGM(subject))) return { error: 'Gamemaster or Assistant access required', status: 403 };
        if (managed && managed.status !== 'active') return { error: 'Encounter is not active', status: 409 };
        if (managed && !managerCommand) return { error: 'Use the GM Combat Manager to rewind this encounter', status: 403 };
        if (!subject || !isAssistantGM(subject)) {
            return { error: 'Unauthorized: Only GMs can move to previous turns', status: 403 };
        }
        if (observed && !matchesObservation(prepared, observed)) {
            return { error: 'Encounter changed; review the current turn before retrying', status: 409 };
        }

        let round = prepared.round;
        let turn = prepared.turn ?? 0;

        // Rewind mirrors the advance contract: with the world skip-defeated
        // toggle enabled, defeated rows are skipped in reverse; crossing the
        // round boundary lands on the previous round's last eligible row, and
        // rewinding past round 1 turn 0 returns the encounter to its
        // unstarted round-zero state.
        const skipDefeated = isSkipDefeatedEnabled();
        const managedTurn = managed ? resolveManagedTurn(prepared, managed, 'previous') : null;
        if (managed && !managedTurn) return { error: 'No eligible scored, unskipped combatants', status: 409 };
        const eligible = (row: PreparedEncounter['rows'][number]): boolean =>
            !skipDefeated || !row.defeated;
        const previousEligible = (before: number): number => {
            for (let i = Math.min(before, prepared.rows.length) - 1; i >= 0; i -= 1) {
                if (eligible(prepared.rows[i])) return i;
            }
            return -1;
        };
        const lastEligible = (): number => {
            for (let i = prepared.rows.length - 1; i >= 0; i -= 1) {
                if (eligible(prepared.rows[i])) return i;
            }
            return Math.max(0, prepared.rows.length - 1);
        };

        if (managedTurn) {
            round = managedTurn.round;
            turn = managedTurn.turn ?? 0;
        } else if (round === 0) {
            // Not started — nothing to rewind.
        } else {
            const previous = previousEligible(turn);
            if (previous >= 0) {
                turn = previous;
            } else if (round > 1) {
                round -= 1;
                turn = lastEligible();
            } else {
                round = 0;
                turn = 0;
            }
        }

        const previousFlag = managed ? { ...managed } : null;
        if (previousFlag) {
            previousFlag.turnPause = null;
            if (round === 0) {
                previousFlag.playerActions = { ...playerActionsFor(previousFlag), initiativeOpen: false,
                    initiativeGeneration: crypto.randomUUID() };
            }
        }
        await createCombatRepository(client).update(combatId, {
            round, turn,
            ...(managed && managerCommand && round === 0 ? { active: false } : {}),
            ...(previousFlag && managerCommand && (managed?.turnPause || round === 0)
                ? { 'flags.world.sheetDelverCombat': previousFlag } : {}),
        });

        return { success: true, round, turn };
    };

    // Initiative roll orchestration with adapter initiative formula fallback.
    // Authorization runs BEFORE any side effect (ADR-0028 Phase 5 preflight /
    // audit CMB-04): an unauthorized caller triggers no roll, no chat
    // message, and no document dispatch. Hidden combatants return the same
    // 404 as missing ones for non-GMs so their existence doesn't leak.
    const previousTurn = (client: CombatClientLike, combatId: string, managerCommand = false,
        observed?: CombatTurnObservation): Promise<CombatTurnExecution | CombatErrorPayload> =>
        managerCommand ? previousTurnCore(client, combatId, true, observed)
            : withEncounterLock(combatId, () => previousTurnCore(client, combatId, false, observed));

    const rollInitiativeCore = async (
        client: CombatClientLike,
        combatId: string,
        combatantId: string,
        body: CombatInitiativeRequestBody,
        managerCommand = false,
        managerInitiativeFallback?: string | null,
    ): Promise<CombatInitiativeSuccessPayload | CombatErrorPayload> => {
        ensureReady();
        const { formula, advantageMode, manualTotal, observed } = body;

        const combat = combatStore.get(combatId);
        if (!combat) return { error: 'Combat not found', status: 404 };

        const subject = resolveSubject(client.userId);
        const managed = readCombatManagerFlag(combat);
        if (hasCombatManagerMarker(combat) && !managed) return { error: 'Encounter unavailable', status: 409 };
        if (managed && managed.status !== 'active') return { error: 'Encounter is not active', status: 409 };
        if (managed && (managed.deletionRequested || managed.historyRemovalRequested)) return { error: 'Encounter is closing', status: 409 };
        if (managed && managerCommand && (!subject || !isAssistantGM(subject))) return { error: 'Gamemaster or Assistant access required', status: 403 };
        if (managed && !managerCommand && subject && isAssistantGM(subject)) {
            return { error: 'Use the GM Combat Manager to roll initiative', status: 403 };
        }
        const playerManaged = !!managed && !managerCommand;
        if (playerManaged && (!subject || isAssistantGM(subject))) return { error: 'Player initiative unavailable', status: 403 };
        if (!subject) return { error: 'Unauthorized', status: 403 };
        const gm = isAssistantGM(subject);
        const scope = playerScope(client);
        const combatant = combat.combatants?.find((c) => (c._id || c.id) === combatantId);
        const actorId = combatant?.actorId;

        const checkManagedOwner = (expectedInitiative: number | null = null): CombatErrorPayload | null => {
            if (!playerManaged) return null;
            if (!samePlayerScope(client, scope)) return { error: 'Encounter changed; refresh before retrying', status: 409 };
            const live = combatStore.get(combatId);
            const flag = readCombatManagerFlag(live);
            const actorSubject = resolveSubject(client.userId);
            if (!live || !flag || flag.status !== 'active' || flag.deletionRequested || flag.historyRemovalRequested
                || !actorSubject || isAssistantGM(actorSubject)) return { error: 'Encounter changed; refresh before retrying', status: 409 };
            const generation = playerInitiativeGeneration(live, flag);
            if (!generation || !observed || generation !== observed.phaseGeneration) {
                return { error: 'Initiative phase changed; refresh before retrying', status: 409 };
            }
            const row = live.combatants?.find(item => (item._id || item.id) === combatantId);
            if (!row || row.hidden || !row.actorId) return { error: 'Combatant not found', status: 404 };
            if (row.actorId !== actorId) return { error: 'Combatant changed; refresh before retrying', status: 409 };
            if (!projectionDeps.canWriteActor(row.actorId, actorSubject)) return { error: 'Combatant not found', status: 404 };
            if ((row.initiative ?? null) !== expectedInitiative || observed.initiative !== null) {
                return { error: 'Initiative changed; refresh before retrying', status: 409 };
            }
            return null;
        };
        const initialManagedError = checkManagedOwner();
        if (initialManagedError) return initialManagedError;

        if (!combatant || (combatant.hidden && !gm)) {
            return { error: 'Combatant not found', status: 404 };
        }
        if (!actorId) return { error: 'Actor not found', status: 404 };
        if (!gm && !projectionDeps.canWriteActor(actorId, subject)) {
            return { error: playerManaged ? 'Combatant not found' : 'Unauthorized: You do not own this combatant', status: playerManaged ? 404 : 403 };
        }

        const systemInfo = await client.getSystem();
        const afterSystem = checkManagedOwner();
        if (afterSystem) return afterSystem;
        const adapter = await getAdapter(systemInfo.id.toLowerCase());
        const afterAdapter = checkManagedOwner();
        if (afterAdapter) return afterAdapter;

        const sourceActor = await client.getActor(actorId);
        const afterActor = checkManagedOwner();
        if (afterActor) return afterActor;
        if (!sourceActor || sourceActor.error) {
            return {
                error: sourceActor?.error || 'Actor not found',
                status: sourceActor?.error ? 503 : 404,
            };
        }

        const actor = getPreparedActor(actorId);

        // A guarded manager batch supplies one preference snapshot for every roll.
        const initiativeFallback = managerCommand && managerInitiativeFallback !== undefined
            ? managerInitiativeFallback
            : (await combatStatDisplayService.resolve(client))?.initiativeFormula ?? null;
        const effective = effectiveInitiativeFormula(adapter, actor, initiativeFallback);
        const afterReads = checkManagedOwner();
        if (afterReads) return afterReads;
        if (observed && (observed.initiative !== (combatant.initiative ?? null)
            || observed.formula !== effective.formula)) {
            return { error: 'Initiative changed; review the current value before retrying', status: 409 };
        }
        if (manualTotal !== undefined && (!Number.isFinite(manualTotal) || advantageMode && advantageMode !== 'normal')) {
            return { error: 'Invalid manual initiative total', status: 400 };
        }
        if (manualTotal !== undefined && formula !== undefined) return { error: 'Invalid initiative request', status: 400 };
        if (playerManaged && formula !== undefined) return { error: 'Invalid initiative request', status: 400 };
        if (manualTotal === undefined && !formula && !effective.rollAvailable) return { error: 'Initiative formula cannot resolve for this Actor; enter a value manually', status: 409 };
        if (!formula && advantageMode && advantageMode !== 'normal' && !effective.advantageAvailable) {
            return { error: 'Advantage is unavailable for this initiative formula', status: 400 };
        }
        const finalFormula = manualTotal !== undefined ? String(manualTotal)
            : applyInitiativeMode(formula || effective.formula, advantageMode);

        if (playerManaged) {
            const latestFallback = (await combatStatDisplayService.resolve(client))?.initiativeFormula ?? null;
            const latestActor = getPreparedActor(actorId);
            const latestFormula = effectiveInitiativeFormula(adapter, latestActor, latestFallback);
            const stale = checkManagedOwner();
            if (stale) return stale;
            if (latestFormula.formula !== observed?.formula) {
                return { error: 'Initiative formula changed; refresh before retrying', status: 409 };
            }
        }

        const speaker = {
            actor: actor._id || actor.id,
            alias: actor.name
        };

        // Foundry's rollInitiative whispers hidden Combatant rolls to GMs.
        // A public Core chat message would reveal that hidden participant.
        let chatMessage: RollChatMessageLike;
        try {
            chatMessage = await client.roll(finalFormula, manualTotal !== undefined ? 'Manual Initiative' : 'Initiative', {
                speaker,
                ...(combatant.hidden ? { rollMode: 'gmroll' as const } : {}),
            });
        } catch {
            return { error: 'Roll outcome unknown; refresh and inspect chat before retrying',
                status: 502, code: 'ROLL_OUTCOME_UNKNOWN' };
        }
        let total: number;
        try { total = getCombatInitiativeRollTotal(chatMessage); }
        catch { return { error: 'Rolled, but initiative was not applied; inspect chat before entering the total manually', status: 502,
            code: 'ROLL_NOT_APPLIED' }; }

        if (checkManagedOwner()) {
            return { error: 'Rolled, but initiative was not applied; refresh and inspect chat before entering the total manually',
                status: 409, code: 'ROLL_NOT_APPLIED' };
        }

        const currentId = managed?.turnPause ? null
            : combatEncounterReadModel.getOrRebuild(combatId)?.currentCombatantId ?? null;
        const turnBeforeScore = { round: combat.round ?? 0, turn: combat.turn ?? null, active: combat.active };

        try { await createCombatRepository(client).updateCombatant(combatId, combatantId, { initiative: total }); }
        catch {
            return { error: 'Rolled, but initiative may not have been applied; refresh and inspect chat before retrying',
                status: 502, code: 'ROLL_OUTCOME_UNKNOWN' };
        }
        // Pending-only/paused encounters have no current row to repair, but
        // that must not bypass the post-write identity/scope checks.
        if (playerManaged) {
            const live = combatStore.get(combatId);
            if (!live || live.round !== turnBeforeScore.round || (live.turn ?? null) !== turnBeforeScore.turn
                || live.active !== turnBeforeScore.active || checkManagedOwner(total)) {
                return { error: 'Initiative was applied, but encounter synchronization is uncertain; refresh before continuing',
                    status: 409, code: 'TURN_SYNC_UNKNOWN' };
            }
        }
        if (!managerCommand && currentId && (combat.round ?? 0) > 0) {
            const live = combatStore.get(combatId);
            // A concurrent Foundry/GM turn command is outside our in-process
            // lock. Never restore an old turn over that newer command.
            if (!live || live.round !== turnBeforeScore.round || (live.turn ?? null) !== turnBeforeScore.turn
                || live.active !== turnBeforeScore.active || checkManagedOwner(total)) {
                return { error: 'Initiative was applied, but turn synchronization is uncertain; refresh before continuing',
                    status: 409, code: 'TURN_SYNC_UNKNOWN' };
            }
            const reordered = combatEncounterReadModel.getOrRebuild(combatId);
            const newIndex = reordered?.rows.findIndex(row => row.id === currentId && (!managed || isManagedTurnEligible(row))) ?? -1;
            if (newIndex < 0) return { error: 'Initiative was applied, but turn synchronization is uncertain; refresh before continuing',
                status: 409, code: 'TURN_SYNC_UNKNOWN' };
            if (newIndex >= 0 && combatStore.get(combatId)?.turn !== newIndex) {
                try { await createCombatRepository(client).update(combatId, { turn: newIndex }); }
                catch { return { error: 'Initiative was applied, but turn synchronization is uncertain; refresh before continuing',
                    status: 502, code: 'TURN_SYNC_UNKNOWN' }; }
            }
        }

        return { success: true, initiative: total };
    };

    const rollInitiative = (client: CombatClientLike, combatId: string, combatantId: string,
        body: CombatInitiativeRequestBody, managerCommand = false,
        managerInitiativeFallback?: string | null): Promise<CombatInitiativeSuccessPayload | CombatErrorPayload> =>
        managerCommand ? rollInitiativeCore(client, combatId, combatantId, body, true, managerInitiativeFallback)
            : withEncounterLock(combatId, () => rollInitiativeCore(client, combatId, combatantId, body));

    return {
        listCombats,
        advanceTurn,
        previousTurn,
        rollInitiative
    };
}
