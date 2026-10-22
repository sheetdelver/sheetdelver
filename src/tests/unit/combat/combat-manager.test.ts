import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { combatManagerService, CombatManagerError } from '@server/services/combats/CombatManagerService';
import { discoverActorSortFields, parseActorPickerSort, sortActorChoices } from '@server/services/combats/CombatActorPickerSort';
import { combatStatDisplayService, projectCombatStatFields } from '@server/services/combats/CombatStatDisplayService';
import { combatStatPreferenceStore } from '@server/services/combats/CombatStatPreferenceStore';
import { hasCombatManagerMarker, playerActionsFor, readCombatManagerFlag } from '@server/services/combats/combatManagerFlag';
import { createCombatService } from '@server/services/combats/CombatService';
import { EncounterBusyError } from '@server/services/combats/EncounterCommandGuard';
import { combatEncounterReadModel } from '@server/core/documents/encounters/CombatEncounterReadModel';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { combatStore } from '@server/core/documents/primary/combats/CombatStore';
import { folderStore } from '@server/core/documents/primary/folders/FolderStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { sceneStore } from '@server/core/documents/primary/scenes/SceneStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { compendiumStore } from '@server/core/compendium/CompendiumStore';
import { preparedActorStore } from '@server/core/documents/prepared/actors/PreparedActorStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { __resetDataDirForTests, getDataDir } from '@server/core/paths';
import { BaseSystemAdapter } from '@shared/sdk';
import type { CombatClientLike } from '@server/shared/types/documents';
import type { ActorDocument } from '@server/shared/types/actors';
import { registerCombatRoutes } from '@server/routes/protected/registerCombatRoutes';
import { registerCombatManagerRoutes } from '@server/routes/protected/registerCombatManagerRoutes';
import { createRouteMap, createRouterStub, getLastHandler, invokeHandler } from '../routing/route-test-helpers';

type Call = { type: string; action: string; operation: Record<string, any>; parent?: { type: string; id: string } };

export function mockClient(userId: string, calls: Call[], rolls: string[] = []): CombatClientLike {
    let combatNumber = 0;
    let folderNumber = 0;
    let actorNumber = 0;
    let combatantNumber = 0;
    return {
        userId,
        getSystem: async () => ({ id: 'test' }),
        getActor: async (actorId: string) => actorStore.get(actorId),
        roll: async (formula: string) => {
            rolls.push(formula);
            return { rolls: [{ total: Number.isFinite(Number(formula)) ? Number(formula) : 17 }] };
        },
        resolveUrl: (url?: string) => url || '',
        dispatchDocument: async (type: string, action: string, rawOperation?: unknown, parent?: { type: string; id: string }) => {
            const operation = (rawOperation || {}) as Record<string, any>;
            calls.push({ type, action, operation, parent });
            if (action === 'get' && type === 'Actor' && operation.pack === 'test.monsters') {
                const template = {
                    _id: 'PACK1', name: 'World-Sized Ogre', type: 'npc', img: 'ogre.webp',
                    system: { attributes: { hp: { value: 18, max: 20 } } },
                    items: [{ _id: 'SWORD1', name: 'Sword' }],
                };
                return { result: operation.index ? [template] : [template] };
            }
            if (action === 'get' && type === 'Actor' && operation.pack === 'test.sort-pack') {
                return { result: Array.from({ length: 1000 }, (_, index) => ({
                    _id: `SORT${String(index + 1).padStart(4, '0')}`,
                    name: `Actor ${String(index + 1).padStart(4, '0')}`,
                    type: 'npc', system: { details: { level: 1000 - index } },
                })) };
            }
            if (action === 'create') {
                const row = operation.data[0];
                const id = type === 'Combat' ? `COMBAT${++combatNumber}`
                    : type === 'Folder' ? `FOLDER${++folderNumber}`
                        : type === 'Actor' ? `COPY${++actorNumber}` : `ROW${++combatantNumber}`;
                return { result: [{ ...row, _id: id }] };
            }
            if (action === 'update') return { result: operation.updates };
            if (action === 'delete') return { result: operation.ids };
            throw new Error('Unexpected mock document operation');
        },
    } as unknown as CombatClientLike;
}

export async function seed(): Promise<void> {
    worldStateStore.seed({ world: { id: 'test-world' }, system: { id: 'test' } });
    await userStore.seed(async () => [
        { _id: 'gm', role: 4, permissions: { ACTOR_CREATE: true, FILES_BROWSE: true } },
        { _id: 'assistant', role: 3, permissions: { ACTOR_CREATE: true, FILES_BROWSE: true } },
        { _id: 'player', role: 1 }, { _id: 'trusted', role: 2 }, { _id: 'banned', role: 0 },
    ]);
    await actorStore.seed(async () => [{
        _id: 'WORLDNPC', name: 'Ongoing NPC', type: 'npc', img: 'npc.webp',
        system: { attributes: { hp: { value: 31, max: 31 } } },
    }, {
        _id: 'PLAYERPC', name: 'Player-owned hero', type: 'character',
        ownership: { player: 3 },
    }, {
        _id: 'ASSISTANTNPC', name: 'GM-side ally', type: 'character',
        ownership: { assistant: 3 },
    }] as ActorDocument[]);
    await combatStore.seed(async () => [{ _id: 'UNMARKED', scene: null, round: 0, combatants: [] }]);
    await folderStore.seed(async () => []);
    await sceneStore.seed(async () => []);
    await settingStore.seed(async () => [{ _id: 'TRACKER', key: 'core.combatTrackerConfig', value: JSON.stringify({ resource: 'attributes.hp' }) }]);
    compendiumStore.clear();
    compendiumStore.setPackMetadata('test.monsters', { id: 'test.monsters', type: 'Actor', label: 'Monsters' });
    compendiumStore.setPackMetadata('test.sort-pack', { id: 'test.sort-pack', type: 'Actor', label: 'Sort pack' });
}

async function runManagedQueueRefinements(): Promise<void> {
    await seed();
    preparedActorStore.bind(actorStore);
    preparedActorStore.configure(new BaseSystemAdapter(), { worldEpoch: 1, systemId: 'test' });
    preparedActorStore.rebuildAll();
    const calls: Call[] = [];
    const gm = mockClient('gm', calls), player = mockClient('player', calls);
    actorStore.patch('WORLDNPC', { 'system.notes': '' });
    assert.equal((await combatManagerService.validateStatPath(gm, 'system.notes', 'textarea')).kind, 'textarea');
    await assert.rejects(() => combatManagerService.validateStatPath(gm, 'system.attributes.hp.value', 'textarea'),
        (error: unknown) => error instanceof CombatManagerError && error.status === 400);
    const service = createCombatService({});
    const encounter = await combatManagerService.create(gm, 'Pending queue fixture', false);
    const rowFor = async (actorId: string) => (await combatManagerService.detail(gm, encounter.id)).participants.find(row => row.actorId === actorId)!;
    const next = () => combatManagerService.turn(gm, encounter.id, () => service.advanceTurn(gm, encounter.id, true));
    for (const [id, score] of [['WORLDNPC', 20], ['PLAYERPC', 10], ['ASSISTANTNPC', 0]] as const) {
        await combatManagerService.addWorldActor(gm, encounter.id, id);
        await combatManagerService.updateParticipant(gm, encounter.id, (await rowFor(id)).id, { initiative: score });
    }
    await next(); await next();
    const owner = await rowFor('PLAYERPC');
    assert.equal((await combatManagerService.detail(gm, encounter.id)).currentCombatantId, owner.id);
    for (const id of ['LATEONE', 'LATETWO']) actorStore.upsert({ _id: id, name: id, type: 'arbitrary', ownership: { player: 3 } } as ActorDocument);
    actorStore.upsert({ _id: 'LATENPC', name: 'Private late NPC', type: 'character' } as ActorDocument);
    for (const id of ['LATEONE', 'LATETWO', 'LATENPC']) await combatManagerService.addWorldActor(gm, encounter.id, id);
    const lateNpc = await rowFor('LATENPC');
    assert.equal(lateNpc.hidden, true, 'late hidden default follows ownership, not Actor type');
    // A late owner is admitted automatically after Begin.
    let view = (await service.listCombats(player)).combats.find(row => row.id === encounter.id)!;
    assert.deepEqual(view.initiativeCandidates?.map(row => row.actorId).sort(), ['LATEONE', 'LATETWO']);
    assert.ok(view.combatants.every(row => row.initiative !== null));
    assert.ok(!JSON.stringify(view).includes('LATENPC'), 'hidden pending identity never escapes');
    const phase = view.playerInitiative!.generation;
    const late = view.initiativeCandidates![0];
    assert.ok('success' in await service.rollInitiative(player, encounter.id, late.id,
        { manualTotal: 25, observed: { initiative: null, formula: late.initiativeRoll!.formula, phaseGeneration: phase } }));
    assert.equal((await combatManagerService.detail(gm, encounter.id)).currentCombatantId, owner.id, 'late score cannot steal current turn');
    await combatManagerService.updateParticipant(gm, encounter.id, owner.id, { initiative: null });
    let detail = await combatManagerService.detail(gm, encounter.id);
    assert.equal(detail.currentCombatantId, null);
    assert.equal(detail.awaitingInitiative, true);
    assert.equal(combatStore.get(encounter.id)?.turn, null);
    assert.equal(readCombatManagerFlag(combatStore.get(encounter.id))?.turnPause?.initiative, 10);
    combatEncounterReadModel.clear(); combatEncounterReadModel.rebuildAll();
    assert.equal((await combatManagerService.detail(gm, encounter.id)).awaitingInitiative, true, 'pause survives rebuilding cached runtime state');
    view = (await service.listCombats(player)).combats.find(row => row.id === encounter.id)!;
    assert.equal(view.canAdvanceTurn, false);
    assert.equal(view.currentCombatantId, null);
    const pendingOwner = view.initiativeCandidates!.find(row => row.id === owner.id)!;
    assert.ok('success' in await service.rollInitiative(player, encounter.id, owner.id, { manualTotal: 12.5,
        observed: { initiative: null, formula: pendingOwner.initiativeRoll!.formula, phaseGeneration: phase } }));
    assert.equal((await combatManagerService.detail(gm, encounter.id)).awaitingInitiative, true, 'owner scoring cannot release a GM pause');
    await combatManagerService.updateParticipant(gm, encounter.id, lateNpc.id, { initiative: 1 });
    assert.equal((await combatManagerService.detail(gm, encounter.id)).awaitingInitiative, true, 'unrelated GM score cannot resume pause');
    assert.equal((await rowFor('LATENPC')).hidden, true, 'scoring never reveals the late NPC');
    await next();
    detail = await combatManagerService.detail(gm, encounter.id);
    assert.equal(detail.round, 1, 'regrouping cleared rows never forces a round wrap');
    assert.equal(detail.currentCombatantId, lateNpc.id, 'GM Next resumes after the saved score anchor, including hidden NPC turns');
    const full = combatEncounterReadModel.getOrRebuild(encounter.id)!;
    assert.equal(combatStore.get(encounter.id)?.turn, full.rows.findIndex(row => row.id === lateNpc.id), 'write uses native full-order index');
    await next();
    assert.equal((await combatManagerService.detail(gm, encounter.id)).currentCombatantId, (await rowFor('ASSISTANTNPC')).id, 'zero is a scored eligible turn');
    await next();
    assert.equal((await combatManagerService.detail(gm, encounter.id)).round, 2, 'last scored row wraps without visiting pending rows');
    const activeId = (await combatManagerService.detail(gm, encounter.id)).currentCombatantId!;
    await combatManagerService.resetInitiative(gm, encounter.id);
    assert.equal((await combatManagerService.detail(gm, encounter.id)).canNavigateTurns, false);
    const writeCount = calls.length;
    assert.equal((await next() as any).status, 409);
    assert.equal(calls.length, writeCount, 'all-pending navigation performs no write');
    await combatManagerService.updateParticipant(gm, encounter.id, owner.id, { initiative: 2 });
    assert.equal((await combatManagerService.detail(gm, encounter.id)).awaitingInitiative, true);
    await combatManagerService.updateParticipant(gm, encounter.id, activeId, { initiative: 0 });
    assert.equal((await combatManagerService.detail(gm, encounter.id)).currentCombatantId, activeId, 'explicit GM restoration resumes the cleared current row, including zero');
    settingStore.patch('TRACKER', { value: JSON.stringify({ skipDefeated: true }) });
    for (const row of (await combatManagerService.detail(gm, encounter.id)).participants.filter(row => row.initiative !== null)) {
        await combatManagerService.updateParticipant(gm, encounter.id, row.id, { defeated: true, skip: true });
    }
    assert.equal((await next() as any).status, 409, 'all-skipped scored rows do not fall back onto pending rows');
    await combatManagerService.updateParticipant(gm, encounter.id, owner.id, { defeated: false, skip: false });
    await next();
    assert.equal((await combatManagerService.detail(gm, encounter.id)).currentCombatantId, owner.id);
    const failureClient = { ...gm, dispatchDocument: async (...args: Parameters<typeof gm.dispatchDocument>) => {
        if (args[0] === 'Combatant' && args[1] === 'update') throw new Error('synthetic clear failure');
        return gm.dispatchDocument(...args);
    } } as CombatClientLike;
    await assert.rejects(() => combatManagerService.updateParticipant(failureClient, encounter.id, owner.id, { initiative: null }));
    assert.equal((await rowFor('PLAYERPC')).initiative, 2, 'failed clear leaves old score visible');
    assert.equal((await combatManagerService.detail(gm, encounter.id)).awaitingInitiative, true, 'failed clear does not resume or advance');
    actorStore.patch('PLAYERPC', { effects: [{ _id: 'DEAD', disabled: false, statuses: ['dead'] }] });
    await combatManagerService.updateParticipant(gm, encounter.id, owner.id, { defeated: false });
    const effectiveDead = await rowFor('PLAYERPC');
    assert.equal(effectiveDead.defeatedFlag, false);
    assert.equal(effectiveDead.defeated, true, 'clearing the explicit flag cannot remove Actor-derived dead status');
    assert.deepEqual((actorStore.get('PLAYERPC') as any).effects[0].statuses, ['dead']);
    await combatManagerService.destroy(gm, encounter.id);
    console.log('  - Managed queue: pending privacy, late NPC defaults, pause/restore/native-index navigation and defeated checks passed');
}

async function runManagedSkipRefinements(): Promise<void> {
    await seed();
    const calls: Call[] = [];
    const gm = mockClient('gm', calls), assistant = mockClient('assistant', calls), player = mockClient('player', calls);
    const service = createCombatService({});
    const encounter = await combatManagerService.create(gm, 'Explicit Skip fixture', false);
    assert.equal(encounter.autoSkipDefeatedEnemies, false);
    const detail = () => combatManagerService.detail(gm, encounter.id);
    const rowFor = async (actorId: string) => (await detail()).participants.find(row => row.actorId === actorId)!;
    const next = () => combatManagerService.turn(gm, encounter.id, () => service.advanceTurn(gm, encounter.id, true));
    for (const [id, score] of [['WORLDNPC', 20], ['PLAYERPC', 10], ['ASSISTANTNPC', 0]] as const) {
        await combatManagerService.addWorldActor(gm, encounter.id, id);
        await combatManagerService.updateParticipant(gm, encounter.id, (await rowFor(id)).id, { initiative: score });
    }
    const npc = await rowFor('WORLDNPC'), pc = await rowFor('PLAYERPC'), ally = await rowFor('ASSISTANTNPC');
    settingStore.patch('TRACKER', { value: JSON.stringify({ skipDefeated: true }) });
    await combatManagerService.updateParticipant(gm, encounter.id, npc.id, { defeated: true });
    assert.equal((await rowFor('WORLDNPC')).skip, false, 'default-off policy does not assign Skip');
    await next();
    assert.equal((await detail()).currentCombatantId, npc.id, 'managed defeat alone ignores world-wide setting');
    await combatManagerService.setTurnPolicy(assistant, encounter.id, { autoSkipDefeatedEnemies: true });
    assert.equal((await rowFor('WORLDNPC')).skip, false, 'enabling policy does not backfill existing rows');
    const before = calls.length;
    await combatManagerService.updateParticipant(gm, encounter.id, npc.id, { defeated: true });
    const combined = calls.slice(before).find(call => call.type === 'Combatant' && call.action === 'update')!;
    assert.equal(combined.operation.updates[0].defeated, true);
    assert.equal(combined.operation.updates[0]['flags.world.sheetDelverSkip'], true,
        'Defeated and automatic Skip use one caller-bound Combatant update');
    assert.equal((await detail()).pausedForSkip, true);
    assert.equal((await detail()).awaitingInitiative, false);
    combatEncounterReadModel.clear(); combatEncounterReadModel.rebuildAll();
    assert.equal((await detail()).pausedForSkip, true, 'Skip pause survives cache rebuild');
    assert.equal((await service.listCombats(player)).combats.find(row => row.id === encounter.id)?.currentCombatantId, null);
    await combatManagerService.updateParticipant(gm, encounter.id, npc.id, { skip: false });
    assert.equal((await detail()).currentCombatantId, npc.id, 'explicit Unskip resumes the eligible anchored row');
    assert.equal((await rowFor('WORLDNPC')).defeated, true);
    const writes = calls.length;
    await detail(); await detail(); await service.listCombats(player);
    assert.equal(calls.length, writes, 'reads never assign/reassign Skip');
    assert.equal((await rowFor('WORLDNPC')).skip, false, 'manual opt-out survives reads while defeated');
    await combatManagerService.updateParticipant(gm, encounter.id, pc.id, { defeated: true });
    assert.equal((await rowFor('PLAYERPC')).skip, false, 'player defeat never automatically skips');
    await combatManagerService.updateParticipant(gm, encounter.id, npc.id, { skip: true });
    await next();
    assert.equal((await detail()).currentCombatantId, pc.id);
    assert.equal((await detail()).round, 1, 'current Skip does not cause premature wrap');
    await combatManagerService.updateParticipant(gm, encounter.id, ally.id, { skip: true });
    let tracker = (await service.listCombats(player)).combats.find(row => row.id === encounter.id)!;
    assert.ok(tracker.combatants.some(row => row.id === npc.id && row.skip), 'scored skipped rows remain in authorized roster');
    assert.equal(tracker.nextShownCombatantId, pc.id, 'preview skips explicit flags, not defeated player');
    await combatManagerService.updateParticipant(assistant, encounter.id, pc.id, { skip: true });
    assert.equal((await detail()).canNavigateTurns, false);
    tracker = (await service.listCombats(player)).combats.find(row => row.id === encounter.id)!;
    assert.equal(tracker.canAdvanceTurn, false);
    const noEligibleWrites = calls.length;
    assert.equal((await next() as any).status, 409);
    assert.equal(calls.length, noEligibleWrites, 'all skipped means no turn/round side effects');
    await combatManagerService.updateParticipant(gm, encounter.id, pc.id, { defeated: false });
    assert.equal((await rowFor('PLAYERPC')).skip, true, 'player Restore never erases explicit player Skip');
    await combatManagerService.setTurnPolicy(gm, encounter.id, { autoSkipDefeatedEnemies: false });
    assert.equal((await rowFor('WORLDNPC')).skip, true, 'disabling assignment does not erase Skip flags');
    await combatManagerService.updateParticipant(gm, encounter.id, npc.id, { defeated: false });
    assert.equal((await rowFor('WORLDNPC')).skip, false, 'NPC Restore clears the same Skip flag even with policy off');
    await next();
    const full = combatEncounterReadModel.getOrRebuild(encounter.id)!;
    assert.equal(combatStore.get(encounter.id)?.turn, full.rows.findIndex(row => row.id === npc.id));
    await combatManagerService.setTurnPolicy(gm, encounter.id, { autoSkipDefeatedEnemies: true });
    combatStore.applyModifyDocument('Combatant', 'update', [{ _id: npc.id, defeated: true }], { parentUuid: `Combat.${encounter.id}` });
    actorStore.patch('WORLDNPC', { effects: [{ _id: 'DEAD', disabled: false, statuses: ['dead'] }] });
    assert.equal((await rowFor('WORLDNPC')).skip, false, 'external defeat/Actor death never triggers a privileged writer');
    await combatManagerService.updateParticipant(gm, encounter.id, npc.id, { skip: true });
    await combatManagerService.updateParticipant(gm, encounter.id, npc.id, { defeated: false });
    assert.equal((await rowFor('WORLDNPC')).skip, false);
    assert.equal((await rowFor('WORLDNPC')).defeated, true, 'NPC Restore does not remove Actor dead effects');
    const failureClient = { ...gm, dispatchDocument: async (...args: Parameters<typeof gm.dispatchDocument>) => {
        if (args[0] === 'Combatant' && args[1] === 'update') throw new Error('synthetic Skip write failure');
        return gm.dispatchDocument(...args);
    } } as CombatClientLike;
    await assert.rejects(() => combatManagerService.updateParticipant(failureClient, encounter.id, npc.id, { skip: true }));
    assert.equal((await detail()).pausedForSkip, true, 'failed Skip leaves a safe durable pause');
    assert.equal((await rowFor('WORLDNPC')).skip, false);
    await combatManagerService.updateParticipant(gm, encounter.id, npc.id, { skip: false });
    assert.equal((await detail()).currentCombatantId, npc.id, 'explicit recovery can resume after a failed write');
    await assert.rejects(() => combatManagerService.updateParticipant(player, encounter.id, pc.id, { skip: false }),
        (error: unknown) => error instanceof CombatManagerError && error.status === 403);
    await assert.rejects(() => combatManagerService.updateParticipant(gm, encounter.id, npc.id, { skip: 'yes' }),
        (error: unknown) => error instanceof CombatManagerError && error.status === 400);
    await assert.rejects(() => combatManagerService.setTurnPolicy(gm, encounter.id, { autoSkipDefeatedEnemies: true, unrelated: true }),
        (error: unknown) => error instanceof CombatManagerError && error.status === 400);
    const routes = createRouteMap(); registerCombatManagerRoutes(createRouterStub(routes) as any);
    const policy = getLastHandler(routes, 'patch', '/combat-manager/:id/turn-policy');
    assert.equal((await invokeHandler(policy, { params: { id: encounter.id }, foundryClient: player,
        body: { autoSkipDefeatedEnemies: false } } as any)).statusCode, 403);
    assert.equal((await invokeHandler(policy, { params: { id: encounter.id }, foundryClient: assistant,
        body: { autoSkipDefeatedEnemies: false } } as any)).statusCode, 200);
    combatStore.applyModifyDocument('Combatant', 'update', [{ _id: ally.id, 'flags.world.sheetDelverSkip': 'malformed' }],
        { parentUuid: `Combat.${encounter.id}` });
    assert.equal((await rowFor('ASSISTANTNPC')).skip, true, 'malformed explicit flags fail closed until repaired');
    await combatManagerService.updateParticipant(gm, encounter.id, ally.id, { skip: false });
    assert.equal((await rowFor('ASSISTANTNPC')).skip, false);
    const gate = requestGate();
    const slow = { ...gm, dispatchDocument: async (...args: Parameters<typeof gm.dispatchDocument>) => {
        if (args[0] === 'Combatant' && args[1] === 'update') await gate.pause();
        return gm.dispatchDocument(...args);
    } } as CombatClientLike;
    const first = combatManagerService.updateParticipant(slow, encounter.id, ally.id, { skip: true });
    await gate.entered;
    await assert.rejects(() => combatManagerService.updateParticipant(assistant, encounter.id, ally.id, { skip: false }),
        (error: unknown) => error instanceof EncounterBusyError && error.status === 409);
    gate.release(); await first;
    const identityGate = requestGate();
    const pausingClient = { ...gm, dispatchDocument: async (...args: Parameters<typeof gm.dispatchDocument>) => {
        if (args[0] === 'Combat' && args[1] === 'update') await identityGate.pause();
        return gm.dispatchDocument(...args);
    } } as CombatClientLike;
    const changesBefore = calls.filter(call => call.type === 'Combatant' && call.action === 'update').length;
    const reassigned = combatManagerService.updateParticipant(pausingClient, encounter.id, npc.id, { skip: true });
    const reassignedRejected = assert.rejects(reassigned, (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    await identityGate.entered;
    combatStore.applyModifyDocument('Combatant', 'update', [{ _id: npc.id, actorId: 'PLAYERPC' }], { parentUuid: `Combat.${encounter.id}` });
    identityGate.release(); await reassignedRejected;
    assert.equal(calls.filter(call => call.type === 'Combatant' && call.action === 'update').length, changesBefore,
        'a target reassigned during pause is rejected before Skip side effects');
    combatStore.applyModifyDocument('Combatant', 'update', [{ _id: npc.id, actorId: 'WORLDNPC' }], { parentUuid: `Combat.${encounter.id}` });
    await combatManagerService.updateParticipant(gm, encounter.id, npc.id, { skip: false });
    const scoreGate = requestGate();
    const clearingClient = { ...gm, dispatchDocument: async (...args: Parameters<typeof gm.dispatchDocument>) => {
        if (args[0] === 'Combat' && args[1] === 'update') await scoreGate.pause();
        return gm.dispatchDocument(...args);
    } } as CombatClientLike;
    const clear = combatManagerService.updateParticipant(clearingClient, encounter.id, npc.id, { initiative: null, expectedInitiative: 20 });
    const staleClearRejected = assert.rejects(clear, (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    await scoreGate.entered;
    combatStore.applyModifyDocument('Combatant', 'update', [{ _id: npc.id, initiative: 21 }], { parentUuid: `Combat.${encounter.id}` });
    scoreGate.release(); await staleClearRejected;
    assert.equal((await rowFor('WORLDNPC')).initiative, 21, 'score observation is rechecked after pausing before clear');
    await combatManagerService.updateParticipant(gm, encounter.id, npc.id, { initiative: 20 });
    const flagSnapshot = combatStore.get(encounter.id)!;
    assert.equal(readCombatManagerFlag({ ...flagSnapshot, flags: { world: { sheetDelverCombat: {
        ...readCombatManagerFlag(flagSnapshot), turnPause: { combatantId: npc.id, initiative: 20, reason: ['skip'] },
    } } } } as any), null, 'pause reason requires a real validated enum string');
    const originalResolve = combatStatDisplayService.resolve;
    try {
        for (const change of ['role', 'world'] as const) {
            const readGate = requestGate();
            combatStatDisplayService.resolve = async client => { const result = await originalResolve(client); await readGate.pause(); return result; };
            const pendingRead = combatManagerService.detail(gm, encounter.id);
            const rejected = assert.rejects(pendingRead, (error: unknown) => error instanceof CombatManagerError
                && error.status === (change === 'role' ? 403 : 503));
            await readGate.entered;
            if (change === 'role') userStore.patch('gm', { role: 1 });
            else worldStateStore.seed({ world: { id: 'replacement-world' }, system: { id: 'test' } });
            readGate.release(); await rejected;
            userStore.patch('gm', { role: 4 });
            worldStateStore.seed({ world: { id: 'test-world' }, system: { id: 'test' } });
        }
    } finally { combatStatDisplayService.resolve = originalResolve; }
    await combatManagerService.destroy(gm, encounter.id);
    console.log('  - Explicit managed Skip: default-off NPC assignment, manual opt-out/Restore, players, pause/failure/native indexes and HTTP permissions passed');
}

/** Pause a real service await so mutations race with the request, not its setup. */
function requestGate() {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Service did not reach the paused await')), 5000);
        enter = () => { clearTimeout(timeout); resolve(); };
    });
    const resumed = new Promise<void>(resolve => { release = resolve; });
    return { entered, release, pause: async () => { enter(); await resumed; } };
}

export async function runParticipationHardening(): Promise<void> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-participation-guards-'));
    const previousWorld = worldStateStore.getGameDataSnapshot();
    let previousDataDir: string | null = null;
    try { previousDataDir = getDataDir(); } catch { /* Standalone run. */ }
    const calls: Call[] = [];
    const rolls: string[] = [];
    const player = mockClient('player', calls, rolls);
    const coowner = mockClient('coowner', calls, rolls);
    const service = createCombatService({});
    const policy = { initiativeOpen: true, initiativeGeneration: 'phase-one', endTurnEnabled: true };
    const observed = { initiative: null, formula: '1d20', phaseGeneration: 'phase-one' };
    const patchRow = (updates: Record<string, unknown>) => combatStore.applyModifyDocument('Combatant', 'update',
        [{ _id: 'OWNERROW', ...updates }], { parentUuid: 'Combat.OWNERGUARD' });
    const patchPolicy = (updates: Record<string, unknown>) => combatStore.patch('OWNERGUARD',
        { 'flags.world.sheetDelverCombat.playerActions': { ...policy, ...updates } });
    const reset = async () => {
        await seed();
        userStore.upsert({ _id: 'coowner', role: 1 });
        actorStore.patch('PLAYERPC', { ownership: { player: 3, coowner: 3 } });
        actorStore.upsert({ _id: 'ALTPC', name: 'Other owned Actor', type: 'character', ownership: { player: 3 } });
        combatStore.upsert({ _id: 'OWNERGUARD', scene: null, active: false, round: 0, turn: null,
            flags: { world: { sheetDelverCombat: { schemaVersion: 1, mode: 'tokenless',
                label: 'Guard fixture', status: 'active', keepHistory: false, folderId: null,
                copyIds: [], playerActions: { ...policy } } } },
            combatants: [{ _id: 'OWNERROW', actorId: 'PLAYERPC', initiative: null, hidden: false },
                { _id: 'HIDDENROW', actorId: 'WORLDNPC', initiative: 4, hidden: true }],
        });
        preparedActorStore.bind(actorStore);
        preparedActorStore.configure(new BaseSystemAdapter(), { worldEpoch: 1, systemId: 'test' });
        preparedActorStore.rebuildAll();
        calls.length = 0;
        rolls.length = 0;
    };
    const submit = (client: CombatClientLike, manualTotal?: number, advantageMode?: 'advantage' | 'disadvantage') =>
        service.rollInitiative(client, 'OWNERGUARD', 'OWNERROW', { observed, manualTotal, advantageMode });
    try {
        __resetDataDirForTests(dataDir);
        // Active combats automatically admit late unrolled owners; pre-start remains opt-in.
        await reset();
        patchPolicy({ initiativeOpen: false });
        assert.equal((await service.listCombats(player)).combats.find(row => row.id === 'OWNERGUARD'), undefined);
        combatStore.patch('OWNERGUARD', { active: true, round: 1, turn: 0 });
        combatStore.applyModifyDocument('Combatant', 'create', [{ _id: 'LATEOWNER', actorId: 'ALTPC', initiative: null, hidden: false }],
            { parentUuid: 'Combat.OWNERGUARD' });
        const lateTracker = (await service.listCombats(player)).combats.find(row => row.id === 'OWNERGUARD')!;
        assert.deepEqual(lateTracker.initiativeCandidates?.map(row => row.id).sort(), ['LATEOWNER', 'OWNERROW']);
        const lateObserved = { initiative: null, formula: '1d20', phaseGeneration: lateTracker.playerInitiative!.generation };
        assert.ok('error' in await submit(player, 12), 'a pre-start observation cannot roll after start');
        assert.deepEqual(await service.rollInitiative(player, 'OWNERGUARD', 'LATEOWNER', { manualTotal: 0, observed: lateObserved }),
            { success: true, initiative: 0 });
        assert.ok('error' in await service.rollInitiative(player, 'OWNERGUARD', 'LATEOWNER', { manualTotal: 12, observed: lateObserved }),
            'late owners cannot reroll even a zero score');
        assert.deepEqual(rolls, ['0']);
        for (const change of [
            () => combatStore.patch('OWNERGUARD', { active: false }),
            () => patchRow({ hidden: true }),
            () => actorStore.patch('PLAYERPC', { ownership: { player: 0 } }),
            () => combatStore.patch('OWNERGUARD', { 'flags.world.sheetDelverCombat.status': 'completed' }),
            () => combatStore.patch('OWNERGUARD', { round: 0 }),
        ]) {
            await reset(); patchPolicy({ initiativeOpen: false });
            combatStore.patch('OWNERGUARD', { active: true, round: 1, turn: 0 });
            const gate = requestGate();
            const client = { ...player, getActor: async (id: string) => {
                const actor = await player.getActor(id); await gate.pause(); return actor;
            } } as CombatClientLike;
            const pending = service.rollInitiative(client, 'OWNERGUARD', 'OWNERROW', { manualTotal: 12, observed: lateObserved });
            try { await gate.entered; change(); } finally { gate.release(); }
            assert.ok('error' in await pending, 'late-owner eligibility is rechecked after async reads');
            assert.deepEqual(rolls, []); assert.equal(calls.length, 0);
        }
        // Old managed encounters need no write/migration to support late owners.
        await reset();
        const legacy = structuredClone(combatStore.get('OWNERGUARD')!);
        const legacyFlag = readCombatManagerFlag(legacy)!;
        delete legacyFlag.playerActions;
        combatStore.delete('OWNERGUARD');
        combatStore.upsert({ ...legacy, active: true, round: 1, turn: 0 });
        const legacyView = (await service.listCombats(player)).combats.find(row => row.id === 'OWNERGUARD')!;
        assert.equal(legacyView.playerInitiative?.generation, 'active:');
        assert.equal(calls.length, 0);

        // The public owner route accepts a full stored generation plus its active prefix.
        patchPolicy({ initiativeOpen: false, initiativeGeneration: 'x'.repeat(128) });
        const activeRoutes = createRouteMap();
        registerCombatRoutes(createRouterStub(activeRoutes) as any);
        const rollRoute = getLastHandler(activeRoutes, 'post', '/combats/:id/combatants/:combatantId/roll-initiative');
        const routeRequest = { foundryClient: player, params: { id: 'OWNERGUARD', combatantId: 'OWNERROW' },
            body: { manualTotal: 9, observed: { initiative: null, formula: '1d20', phaseGeneration: `active:${'x'.repeat(128)}` } } };
        const routeRoll = await invokeHandler(rollRoute, routeRequest as any);
        assert.equal(routeRoll.statusCode, 200);
        assert.deepEqual(routeRoll.payload, { success: true, initiative: 9 });
        const oversized = await invokeHandler(rollRoute, { ...routeRequest,
            body: { ...routeRequest.body, observed: { ...routeRequest.body.observed, phaseGeneration: 'x'.repeat(136) } } } as any);
        assert.equal(oversized.statusCode, 400);

        // R1: both owned and unowned replacement Actors invalidate the original target.
        for (const stage of ['read', 'chat', 'score'] as const) {
            for (const actorId of ['ALTPC', 'WORLDNPC']) {
                await reset();
                if (stage === 'score') combatStore.patch('OWNERGUARD', { active: true, round: 1, turn: 0 });
                const gate = requestGate();
                const client = { ...player,
                    getActor: async (id: string) => {
                        const actor = await player.getActor(id);
                        if (stage === 'read') await gate.pause();
                        return actor;
                    },
                    roll: async (...args: Parameters<typeof player.roll>) => {
                        const result = await player.roll(...args);
                        if (stage === 'chat') await gate.pause();
                        return result;
                    },
                    dispatchDocument: async (...args: Parameters<typeof player.dispatchDocument>) => {
                        const result = await player.dispatchDocument(...args);
                        if (stage === 'score' && args[0] === 'Combatant') await gate.pause();
                        return result;
                    },
                } as CombatClientLike;
                const pending = service.rollInitiative(client, 'OWNERGUARD', 'OWNERROW', { manualTotal: 12,
                    observed: { ...observed, phaseGeneration: stage === 'score' ? 'active:phase-one' : observed.phaseGeneration } });
                try { await gate.entered; patchRow({ actorId }); } finally { gate.release(); }
                const result = await pending;
                assert.ok('error' in result && result.status === 409, `${stage}: changed Actor association rejected`);
                if ('error' in result && stage !== 'read') {
                    assert.equal(result.code, stage === 'chat' ? 'ROLL_NOT_APPLIED' : 'TURN_SYNC_UNKNOWN');
                }
                assert.equal(rolls.length, stage === 'read' ? 0 : 1, 'no reroll for a changed target');
                assert.equal(calls.filter(call => call.type === 'Combatant').length, stage === 'score' ? 1 : 0);
                assert.equal(calls.filter(call => call.type === 'Combat').length, 0, 'no turn repair onto a changed Actor');
            }
        }

        // R2: final projection must use current subject, rows, flags and request scope.
        const readChanges: Array<{ name: string; userId: string; status?: number;
            change: (client: CombatClientLike & { isConnected: boolean }) => void }> = [
            { name: 'GM demotion', userId: 'gm', change: () => userStore.patch('gm', { role: 1 }) },
            { name: 'Assistant demotion', userId: 'assistant', change: () => userStore.patch('assistant', { role: 1 }) },
            { name: 'phase closure', userId: 'player', change: () => patchPolicy({ initiativeOpen: false }) },
            { name: 'row hidden', userId: 'player', change: () => patchRow({ hidden: true }) },
            { name: 'row removed', userId: 'player', change: () => combatStore.applyModifyDocument('Combatant', 'delete',
                ['OWNERROW'], { parentUuid: 'Combat.OWNERGUARD' }) },
            { name: 'Combat removed', userId: 'player', change: () => combatStore.delete('OWNERGUARD') },
            { name: 'user removed', userId: 'gm', change: () => userStore.delete('gm'), status: 401 },
            { name: 'user banned', userId: 'player', change: () => userStore.patch('player', { role: 0 }), status: 401 },
            { name: 'world replaced', userId: 'player', change: () => worldStateStore.seed({
                world: { id: 'replacement-world' }, system: { id: 'test' } }), status: 503 },
            { name: 'world closed', userId: 'player', change: () => worldStateStore.clearRuntimeState(), status: 503 },
            { name: 'caller replaced', userId: 'player', change: client => { client.userId = 'coowner'; }, status: 401 },
            { name: 'transport lost', userId: 'player', change: client => { client.isConnected = false; }, status: 503 },
        ];
        for (const test of readChanges) {
            await reset();
            actorStore.patch('PLAYERPC', { ownership: { player: 3, gm: 3, assistant: 3 } });
            const gate = requestGate();
            const client = { ...mockClient(test.userId, calls), isConnected: true, getSystem: async () => {
                await gate.pause(); return { id: 'test' };
            } } as CombatClientLike & { isConnected: boolean };
            const pending = service.listCombats(client);
            // Attach rejection observation before mutating the paused request.
            const outcome = pending.then(value => ({ value }), error => ({ error }));
            try { await gate.entered; test.change(client); } finally { gate.release(); }
            const result = await outcome;
            if (test.status !== undefined) {
                assert.ok('error' in result && result.error.status === test.status, test.name);
            } else {
                assert.ok('value' in result, test.name);
                if ('value' in result) {
                    const view = result.value.combats.find(row => row.id === 'OWNERGUARD');
                    if (test.name.endsWith('demotion')) {
                        assert.deepEqual(view?.combatants, [], 'unrolled rows stay out of the turn roster');
                        assert.deepEqual(view?.initiativeCandidates?.map(row => row.id), ['OWNERROW'], 'old-role hidden rows never escape');
                        assert.equal(view?.canManage, false);
                    } else if (test.name === 'phase closure') {
                        assert.equal(view?.playerInitiative, undefined);
                        assert.equal(view, undefined, 'closed pending-only phase leaves no encounter slot');
                    } else assert.equal(view, undefined, 'retired rows/Combats leave no player encounter');
                }
            }
            assert.equal(calls.length, 0, 'tracker reads never dispatch document operations');
        }

        // Changes during the file-backed preference await receive the same revalidation.
        await reset();
        const preferenceGate = requestGate();
        const originalResolve = combatStatDisplayService.resolve;
        combatStatDisplayService.resolve = async client => {
            const value = await originalResolve(client); await preferenceGate.pause(); return value;
        };
        try {
            const pending = service.listCombats(player);
            try { await preferenceGate.entered; patchPolicy({ initiativeOpen: false }); } finally { preferenceGate.release(); }
            assert.equal((await pending).combats.find(row => row.id === 'OWNERGUARD')?.playerInitiative, undefined);
        } finally { combatStatDisplayService.resolve = originalResolve; }

        // Two owners overlap in time; only the admitted request can create chat/write.
        await reset();
        const chatGate = requestGate();
        const first = submit({ ...player, roll: async (...args: Parameters<typeof player.roll>) => {
            const result = await player.roll(...args); await chatGate.pause(); return result;
        } } as CombatClientLike, 0);
        try {
            await chatGate.entered;
            await assert.rejects(() => submit(coowner, 20), (error: any) => error.status === 409 && error.code === 'ENCOUNTER_BUSY');
        } finally { chatGate.release(); }
        assert.deepEqual(await first, { success: true, initiative: 0 });
        const stale = await submit(coowner, 20);
        assert.ok('error' in stale && stale.status === 409, 'first applied score wins, including zero');
        assert.deepEqual(rolls, ['0']);
        assert.equal(calls.filter(call => call.type === 'Combatant').length, 1);

        // Turn requests use the same encounter guard while the caller's write awaits.
        await reset();
        patchRow({ initiative: 12 });
        combatStore.patch('OWNERGUARD', { active: true, round: 1, turn: 0 });
        const turnGate = requestGate();
        const turnObserved = { active: true, started: true, round: 1, currentCombatantId: 'OWNERROW' };
        const firstTurn = service.advanceTurn({ ...player, dispatchDocument: async (...args: Parameters<typeof player.dispatchDocument>) => {
            await turnGate.pause(); return player.dispatchDocument(...args);
        } } as CombatClientLike, 'OWNERGUARD', false, turnObserved);
        try {
            await turnGate.entered;
            await assert.rejects(() => service.advanceTurn(coowner, 'OWNERGUARD', false, turnObserved),
                (error: any) => error.status === 409 && error.code === 'ENCOUNTER_BUSY');
        } finally { turnGate.release(); }
        assert.ok('success' in await firstTurn);
        assert.equal(calls.filter(call => call.type === 'Combat').length, 1);

        const preflightChanges = [
            () => actorStore.patch('PLAYERPC', { ownership: { player: 0 } }),
            () => patchRow({ hidden: true }),
            () => combatStore.applyModifyDocument('Combatant', 'delete', ['OWNERROW'], { parentUuid: 'Combat.OWNERGUARD' }),
            () => patchPolicy({ initiativeOpen: false }),
            () => patchPolicy({ initiativeGeneration: 'phase-two' }),
            () => combatStore.patch('OWNERGUARD', { 'flags.world.sheetDelverCombat.status': 'cleaning' }),
            () => worldStateStore.clearRuntimeState(),
            () => userStore.delete('player'),
        ];
        for (const change of preflightChanges) {
            await reset();
            const gate = requestGate();
            const client = { ...player, getActor: async (id: string) => {
                const actor = await player.getActor(id); await gate.pause(); return actor;
            } } as CombatClientLike;
            const pending = submit(client, 12);
            try { await gate.entered; change(); } finally { gate.release(); }
            const result = await pending;
            assert.ok('error' in result, 'lost authority during an await rejects the submission');
            assert.deepEqual(rolls, []);
            assert.equal(calls.length, 0);
        }
        await reset();
        const disconnected = { ...player, isConnected: false } as CombatClientLike;
        assert.ok('error' in await submit(disconnected, 12));
        assert.deepEqual(rolls, []);

        for (const [manual, mode, formula] of [[undefined, undefined, '1d20'],
            [undefined, 'advantage', '2d20kh1'], [undefined, 'disadvantage', '2d20kl1'],
            [12.5, undefined, '12.5']] as const) {
            await reset();
            assert.ok('success' in await submit(player, manual, mode));
            assert.deepEqual(rolls, [formula]);
        }
        // Known post-chat policy loss has no score write; timeout is uncertain.
        await reset();
        const closedAfterChat = await submit({ ...player, roll: async (...args: Parameters<typeof player.roll>) => {
            const result = await player.roll(...args); patchPolicy({ initiativeOpen: false }); return result;
        } } as CombatClientLike, 8);
        assert.ok('error' in closedAfterChat && closedAfterChat.code === 'ROLL_NOT_APPLIED');
        assert.equal(rolls.length, 1);
        assert.equal(calls.length, 0);
        await reset();
        const timeout = await submit({ ...player, roll: async (...args: Parameters<typeof player.roll>) => {
            await player.roll(...args); throw new Error('Synthetic chat acknowledgement timeout');
        } } as CombatClientLike, 8);
        assert.ok('error' in timeout && timeout.code === 'ROLL_OUTCOME_UNKNOWN');
        assert.equal(rolls.length, 1);
        assert.equal(calls.length, 0);

        // Public HTTP acknowledgements expose no positional turn information.
        await reset();
        patchRow({ initiative: 12 });
        combatStore.patch('OWNERGUARD', { active: true, round: 1, turn: 0 });
        const tracker = (await service.listCombats(player)).combats.find(row => row.id === 'OWNERGUARD')!;
        const routes = createRouteMap();
        registerCombatRoutes(createRouterStub(routes) as any);
        const next = getLastHandler(routes, 'post', '/combats/:id/next-turn');
        const response = await invokeHandler(next, { foundryClient: player, params: { id: 'OWNERGUARD' },
            body: { observed: { active: tracker.active, started: tracker.started, round: tracker.round,
                currentCombatantId: tracker.currentCombatantId } } } as any);
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.payload, { success: true });
        const staleResponse = await invokeHandler(next, { foundryClient: player, params: { id: 'OWNERGUARD' },
            body: { observed: { active: tracker.active, started: tracker.started, round: tracker.round,
                currentCombatantId: tracker.currentCombatantId } } } as any);
        assert.notEqual(staleResponse.statusCode, 200);
        assert.equal(calls.filter(call => call.type === 'Combat').length, 1, 'stale HTTP turn is never replayed');
        userStore.delete('player');
        const read = await invokeHandler(getLastHandler(routes, 'get', '/combats'), { foundryClient: player } as any);
        assert.equal(read.statusCode, 401, 'HTTP preserves retired-session status');
        await reset();
        worldStateStore.clearRuntimeState();
        const unavailable = await invokeHandler(getLastHandler(routes, 'get', '/combats'), { foundryClient: player } as any);
        assert.equal(unavailable.statusCode, 503, 'HTTP preserves retired-world status');
        console.log('  - Managed participation: Actor continuity, fresh tracker scope, concurrent owners and partial outcomes passed');
    } finally {
        preparedActorStore.clear();
        worldStateStore.clear();
        if (previousWorld) worldStateStore.seed(previousWorld);
        __resetDataDirForTests(previousDataDir);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

async function verifyCustomStatPaths(gm: CombatClientLike, calls: Call[], dataDir: string): Promise<void> {
    actorStore.applyModifyDocument('Actor', 'update', [{ _id: 'WORLDNPC',
        'system.custom': { zero: 0, negative: -2.5, text: 'Displayable', notNumber: '12',
            resource: { value: 0, max: null }, list: [1, 2] } }]);
    assert.deepEqual(await combatManagerService.validateStatPath(gm, 'system.custom.zero', 'number'),
        { path: 'system.custom.zero', kind: 'number', observedActorTypes: ['npc'] });
    assert.equal((await combatManagerService.validateStatPath(mockClient('assistant', calls),
        'system.custom.negative', 'number')).kind, 'number');
    assert.equal((await combatManagerService.validateStatPath(gm, 'system.custom.text', 'text')).kind, 'text');
    assert.equal((await combatManagerService.validateStatPath(gm, 'system.custom.resource', 'resource')).kind, 'resource');
    for (const [path, kind, status] of [
        ['system.__proto__.value', 'number', 400], ['system.custom.missing', 'number', 404],
        ['system.custom.notNumber', 'number', 400], ['system.custom.zero', 'resource', 400],
        ['system.custom.list', 'number', 400], ['system.custom.zero', 'wrong', 400],
    ] as const) {
        await assert.rejects(() => combatManagerService.validateStatPath(gm, path, kind),
            (error: unknown) => error instanceof CombatManagerError && error.status === status);
    }
    await assert.rejects(() => combatManagerService.validateStatPath(mockClient('player', calls), 'system.custom.zero', 'number'),
        (error: unknown) => error instanceof CombatManagerError && error.status === 403);
    // Exact custom lookup must not confuse catalog sampling with existence.
    actorStore.applyModifyDocument('Actor', 'create', Array.from({ length: 5 }, (_, index) => ({
        _id: `FIELD${index}`, type: 'npc', system: index === 4 ? { unsampled: 7 } : {}, ownership: { default: 0 },
    })));
    assert.equal((await combatManagerService.validateStatPath(gm, 'system.unsampled', 'number')).path, 'system.unsampled');
    assert.equal((await combatManagerService.validateStatPath(mockClient('assistant', calls), 'system.unsampled', 'number')).path,
        'system.unsampled', 'native Assistant Actor ownership applies without a service transport');
    const managerRoutes = createRouteMap();
    registerCombatManagerRoutes(createRouterStub(managerRoutes) as any);
    const validate = getLastHandler(managerRoutes, 'post', '/combat-manager/stat-preferences/validate-path');
    const result = await invokeHandler(validate, { foundryClient: gm, body: { path: 'system.custom.zero', kind: 'number' } } as any);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.payload, { attribute: { path: 'system.custom.zero', kind: 'number', observedActorTypes: ['npc'] } });
    assert.equal((await invokeHandler(validate, { foundryClient: gm,
        body: { path: 'system.missing', kind: 'number' } } as any)).statusCode, 404);
    assert.equal((await invokeHandler(validate, { foundryClient: mockClient('player', calls),
        body: { path: 'system.custom.zero', kind: 'number' } } as any)).statusCode, 403);
    assert.equal(fs.existsSync(path.join(dataDir, 'config/gm-combat-stats.json')), false,
        'path validation does not create preference files');
}

export async function runInitiativeOverrideValidation(): Promise<void> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-initiative-override-'));
    const previousWorld = worldStateStore.getGameDataSnapshot();
    let previousDataDir: string | null = null;
    try { previousDataDir = getDataDir(); } catch { /* Focused standalone run. */ }
    const calls: Call[] = [], rolls: string[] = [];
    const gm = mockClient('gm', calls, rolls);
    const formula = '1d20+@system.init';
    const saved = () => combatStatPreferenceStore.getInitiativeFormula('test-world', 'test');
    const reset = async () => {
        await seed();
        preparedActorStore.bind(actorStore);
        preparedActorStore.configure(new BaseSystemAdapter(), { worldEpoch: 1, systemId: 'test' });
        preparedActorStore.rebuildAll();
    };
    const addParticipants = () => {
        actorStore.applyModifyDocument('Actor', 'update', [
            { _id: 'WORLDNPC', 'system.init': 1.5 }, { _id: 'PLAYERPC', 'system.init': 0 },
        ]);
        combatStore.applyModifyDocument('Combat', 'create', ['WORLDNPC', 'PLAYERPC'].map((actorId, index) => ({
            _id: `OVERRIDE${index}`, scene: null, active: false,
            flags: { world: { sheetDelverCombat: { schemaVersion: 1, mode: 'tokenless',
                label: `Override ${index}`, status: 'active', keepHistory: false, folderId: null, copyIds: [] } } },
            combatants: [{ _id: `ROW${index}`, actorId, hidden: index === 1, initiative: index === 1 ? 10 : null }],
        })));
    };
    try {
        __resetDataDirForTests(dataDir);
        await reset();
        await verifyCustomStatPaths(gm, calls, dataDir);
        assert.equal((await combatManagerService.saveInitiativeFormula(gm, '1d20+2')).initiativeFormula, '1d20+2');
        await assert.rejects(() => combatManagerService.saveInitiativeFormula(gm, formula), /Add encounter participants/);
        assert.equal(saved(), '1d20+2', 'no participants cannot falsely validate an attribute formula');
        addParticipants();
        await combatManagerService.saveInitiativeFormula(mockClient('assistant', calls), formula);
        assert.equal(saved(), formula, 'native-authorized Assistants can save a validated override');
        const persisted = fs.readFileSync(path.join(dataDir, 'config/gm-combat-stats.json'), 'utf8');
        for (const invalid of ['1d20+@system.missing', '101d6', '1d20/0', '1d20+@system.__proto__.value']) {
            await assert.rejects(() => combatManagerService.saveInitiativeFormula(gm, invalid),
                (error: unknown) => error instanceof CombatManagerError && error.status === 400);
            assert.equal(fs.readFileSync(path.join(dataDir, 'config/gm-combat-stats.json'), 'utf8'), persisted);
        }
        actorStore.applyModifyDocument('Actor', 'update', [{ _id: 'PLAYERPC', 'system.init': 'not numeric' }]);
        await assert.rejects(() => combatManagerService.saveInitiativeFormula(gm, formula), /non-numeric/,
            'a hidden/scored participant in another managed encounter is also validated');
        actorStore.applyModifyDocument('Actor', 'update', [{ _id: 'PLAYERPC', 'system.init': 0 }]);
        const changedActorClient = { ...gm, getSystem: async () => {
            actorStore.applyModifyDocument('Actor', 'update', [{ _id: 'WORLDNPC', 'system.init': 'changed' }]);
            return { id: 'test' };
        } } as CombatClientLike;
        await assert.rejects(() => combatManagerService.saveInitiativeFormula(changedActorClient, formula), /non-numeric/);
        assert.equal(saved(), formula, 'failed save preserves the prior expression');
        const changes = [
            { status: 403, change: (_client: CombatClientLike) => userStore.patch('gm', { role: 1 }) },
            { status: 401, change: (client: CombatClientLike) => { client.userId = 'assistant'; } },
            { status: 401, change: (_client: CombatClientLike) => userStore.applyModifyDocument('User', 'delete', ['gm']) },
            { status: 401, change: (_client: CombatClientLike) => userStore.patch('gm', { banned: true }) },
            { status: 503, change: (_client: CombatClientLike) => worldStateStore.seed({ world: { id: 'replacement' }, system: { id: 'test' } }) },
            { status: 503, change: (client: CombatClientLike) => { (client as any).isConnected = false; } },
            { status: 503, change: (_client: CombatClientLike) => worldStateStore.clearRuntimeState() },
        ];
        for (const test of changes) {
            await reset(); addParticipants();
            const client = { ...gm, isConnected: true, getSystem: async () => {
                test.change(client); return { id: 'test' };
            } } as CombatClientLike;
            await assert.rejects(() => combatManagerService.saveInitiativeFormula(client, '1d20+3'),
                (error: unknown) => error instanceof CombatManagerError && error.status === test.status);
            assert.equal(saved(), formula, 'retired scope/role cannot replace the preference');
            await reset();
            const pathClient = { ...gm, isConnected: true, getSystem: async () => {
                test.change(pathClient); return { id: 'test' };
            } } as CombatClientLike;
            await assert.rejects(() => combatManagerService.validateStatPath(pathClient, 'system.attributes.hp.value', 'number'),
                (error: unknown) => error instanceof CombatManagerError && error.status === test.status);
            for (const operation of ['save', 'reset'] as const) {
                await reset();
                const statClient = { ...gm, isConnected: true, getSystem: async () => {
                    test.change(statClient); return { id: 'test' };
                } } as CombatClientLike;
                await assert.rejects(() => operation === 'save' ? combatManagerService.saveStatPreferences(statClient, [])
                    : combatManagerService.resetStatPreferences(statClient),
                (error: unknown) => error instanceof CombatManagerError && error.status === test.status);
            }
        }
        await reset(); addParticipants();
        await assert.rejects(() => combatManagerService.saveInitiativeFormula(mockClient('player', calls), '1d20'),
            (error: unknown) => error instanceof CombatManagerError && error.status === 403);
        await assert.rejects(() => combatManagerService.saveInitiativeFormula({ ...gm,
            getSystem: async () => ({ id: 'other' }) } as CombatClientLike, '1d20'),
            (error: unknown) => error instanceof CombatManagerError && error.status === 503);
        assert.equal((await combatManagerService.saveInitiativeFormula(gm, null)).initiativeFormula, null);
        assert.equal(saved(), null, 'clear restores module-first resolution');
        assert.equal(calls.length, 0, 'validation never dispatches Foundry writes');
        assert.equal(rolls.length, 0, 'validation never rolls or creates chat');
        await combatManagerService.saveInitiativeFormula(gm, formula);
        combatStore.applyModifyDocument('Combat', 'update', [{ _id: 'OVERRIDE1',
            'flags.world.sheetDelverCombat.playerActions': { initiativeOpen: true,
                initiativeGeneration: 'override-phase', endTurnEnabled: true },
            combatants: [{ _id: 'ROW1', actorId: 'PLAYERPC', hidden: false, initiative: null }],
        }]);
        const owner = mockClient('player', calls, rolls);
        const service = createCombatService({});
        const view = (await service.listCombats(owner)).combats.find(row => row.id === 'OVERRIDE1')!;
        const observed = { initiative: null, formula: view.initiativeCandidates![0].initiativeRoll!.formula,
            phaseGeneration: view.playerInitiative!.generation };
        assert.equal(observed.formula, '1d20+0');
        actorStore.applyModifyDocument('Actor', 'update', [{ _id: 'PLAYERPC', 'system.init': 'missing now' }]);
        const invalidView = (await service.listCombats(owner)).combats.find(row => row.id === 'OVERRIDE1')!;
        assert.equal(invalidView.initiativeCandidates![0].initiativeRoll!.rollAvailable, false);
        assert.equal((await service.rollInitiative(owner, 'OVERRIDE1', 'ROW1', { observed }) as any).status, 409,
            'a valid saved override cannot certify later missing Actor values');
        actorStore.applyModifyDocument('Actor', 'update', [{ _id: 'PLAYERPC', 'system.init': 0 }]);
        const changedDuringRead = { ...owner, getActor: async (id: string) => {
            const source = actorStore.get(id);
            actorStore.applyModifyDocument('Actor', 'update', [{ _id: id, 'system.init': 2 }]);
            return source;
        } } as CombatClientLike;
        assert.equal((await service.rollInitiative(changedDuringRead, 'OVERRIDE1', 'ROW1', { observed }) as any).status, 409);
        assert.equal(rolls.length, 0, 'post-save invalidation makes no chat or fallback roll');
        assert.equal(calls.length, 0, 'post-save invalidation makes no score writes');
        await combatManagerService.saveInitiativeFormula(gm, null);
        console.log('  - Initiative override: all-participant validation, persistence and retired-scope checks passed');
    } finally {
        preparedActorStore.clear(); worldStateStore.clear();
        if (previousWorld) worldStateStore.seed(previousWorld);
        __resetDataDirForTests(previousDataDir);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

export async function run(): Promise<void> {
    assert.deepEqual(projectCombatStatFields({ type: 'npc', system: { attributes: { hp: { value: 0, max: 20 } } },
        derived: { ac: 15 } } as any, [
        { key: 'hp', label: 'HP', path: 'system.attributes.hp', kind: 'resource', showInRoster: true },
        { key: 'ac', label: 'AC', path: 'derived.ac', kind: 'number' },
    ]), [{ title: 'HP', value: 0, subValue: '/ 20', showInRoster: true }, { title: 'AC', value: 15 }]);
    assert.deepEqual(projectCombatStatFields({ type: 'npc', system: { hp: 9 }, derived: { ac: 14 } } as any, [
        { key: 'ac', label: 'AC', path: 'derived.ac', kind: 'number', showInRoster: true },
        { key: 'hp', label: 'HP', path: 'system.hp', kind: 'number', showInRoster: true },
    ]).map(stat => stat.title), ['AC', 'HP'], 'roster pill projection follows configured stat order');
    assert.equal(projectCombatStatFields({ type: 'npc', system: { hp: 12 }, derived: {} } as any,
        [{ key: 'hp', label: 'HP', path: 'system.hp', kind: 'number', editable: true }],
        { _id: 'SOURCE', type: 'npc', system: { hp: 9 } } as ActorDocument)[0]?.edit, undefined,
    'a transformed prepared value cannot write the different source Actor number');
    assert.equal(projectCombatStatFields({ type: 'npc', system: { hp: { value: 12 } }, derived: {} } as any,
        [{ key: 'hp', label: 'HP', path: 'system.hp', kind: 'resource', editable: true }],
        { _id: 'SOURCE', type: 'npc', system: { hp: 12 } } as ActorDocument)[0]?.edit, undefined,
    'a resource descriptor cannot write a scalar source path');
    await seed();
    preparedActorStore.bind(actorStore);
    preparedActorStore.configure(new BaseSystemAdapter(), { worldEpoch: 1, systemId: 'test' });
    preparedActorStore.rebuildAll();
    const calls: Call[] = [];
    const gm = mockClient('gm', calls);
    const assistant = mockClient('assistant', calls);
    const playerRolls: string[] = [];
    const player = mockClient('player', calls, playerRolls);

    for (const restricted of [player, mockClient('trusted', calls), mockClient('banned', calls)]) {
        await assert.rejects(() => combatManagerService.list(restricted), (error: unknown) => error instanceof CombatManagerError && error.status === 403);
        await assert.rejects(() => combatManagerService.statPreferences(restricted), (error: unknown) => error instanceof CombatManagerError && error.status === 403);
        await assert.rejects(() => combatManagerService.saveStatPreferences(restricted, []), (error: unknown) => error instanceof CombatManagerError && error.status === 403);
        await assert.rejects(() => combatManagerService.resetStatPreferences(restricted), (error: unknown) => error instanceof CombatManagerError && error.status === 403);
        assert.throws(() => combatManagerService.worldActors(restricted, ''), (error: unknown) => error instanceof CombatManagerError && error.status === 403);
        await assert.rejects(() => combatManagerService.packActors(restricted, 'test.monsters', ''),
            (error: unknown) => error instanceof CombatManagerError && error.status === 403);
        await assert.rejects(() => combatManagerService.create(restricted, 'Forbidden', false), (error: unknown) => error instanceof CombatManagerError && error.status === 403);
    }
    assert.equal(calls.length, 0, 'role rejection occurs before Foundry writes');
    await assert.rejects(() => combatManagerService.detail(gm, 'UNMARKED'), (error: unknown) => error instanceof CombatManagerError && error.status === 404);
    assert.equal(readCombatManagerFlag({ scene: 'SCENE1', flags: { world: { sheetDelverCombat: {
        schemaVersion: 1, mode: 'tokenless', label: 'Scene encounter', status: 'active',
        keepHistory: false, folderId: null, copyIds: [],
    } } } }), null, 'scene-linked Combat is never adopted');

    const created = await combatManagerService.create(gm, 'Bridge ambush', false);
    assert.equal(created.status, 'active');
    assert.equal(created.keepHistory, false);
    assert.deepEqual(created.playerActions, { initiativeOpen: false, endTurnEnabled: true, eligible: 0, scored: 0 });
    assert.deepEqual(playerActionsFor(readCombatManagerFlag(combatStore.get(created.id))!),
        { initiativeOpen: false, initiativeGeneration: '', endTurnEnabled: true });
    assert.equal(hasCombatManagerMarker({ scene: null, flags: { world: { sheetDelverCombat: { mode: 'broken' } } } }), true);
    const opened = await combatManagerService.setPlayerActions(gm, created.id, { initiativeOpen: true });
    assert.equal(opened.playerActions.initiativeOpen, true);
    const openGeneration = readCombatManagerFlag(combatStore.get(created.id))!.playerActions!.initiativeGeneration;
    assert.ok(openGeneration);
    await combatManagerService.setPlayerActions(gm, created.id, { endTurnEnabled: false });
    assert.equal(readCombatManagerFlag(combatStore.get(created.id))!.playerActions!.initiativeGeneration, openGeneration);
    const closed = await combatManagerService.setPlayerActions(gm, created.id, { initiativeOpen: false });
    assert.equal(closed.playerActions.initiativeOpen, false);
    assert.equal(closed.playerActions.endTurnEnabled, false);
    assert.notEqual(readCombatManagerFlag(combatStore.get(created.id))!.playerActions!.initiativeGeneration, openGeneration);
    await assert.rejects(() => combatManagerService.setPlayerActions(player, created.id, { initiativeOpen: true }),
        (error: unknown) => error instanceof CombatManagerError && error.status === 403);
    const createsBeforeDuplicate = calls.filter(call => call.type === 'Combat' && call.action === 'create').length;
    const foldersBeforeDuplicate = calls.filter(call => call.type === 'Folder' && call.action === 'create').length;
    await assert.rejects(() => combatManagerService.create(gm, '  bridge  AMBUSH ', true),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409
            && error.message === 'A combat already exists with that name');
    assert.equal(calls.filter(call => call.type === 'Combat' && call.action === 'create').length, createsBeforeDuplicate,
        'duplicate name is rejected before any new Combat write');
    assert.equal(calls.filter(call => call.type === 'Folder' && call.action === 'create').length, foldersBeforeDuplicate,
        'duplicate name is rejected before any new Folder write');
    const racing = await Promise.allSettled([
        combatManagerService.create(gm, 'Racing encounter', false),
        combatManagerService.create(gm, 'RACING ENCOUNTER', false),
    ]);
    assert.equal(racing.filter(result => result.status === 'fulfilled').length, 1,
        'concurrent GMs cannot create two Combats with the same normalized name');
    assert.equal(racing.filter(result => result.status === 'rejected'
        && result.reason instanceof CombatManagerError && result.reason.status === 409).length, 1);
    await combatManagerService.destroy(gm, (racing.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<any>).value.id);
    const combatId = created.id;
    assert.equal(combatStore.get(combatId)?.active, false,
        'creating a manager encounter must not deactivate an existing Foundry Combat');
    const flag = readCombatManagerFlag(combatStore.get(combatId));
    assert.ok(flag?.folderId, 'dedicated Actor Folder recorded on the Combat');
    assert.equal(folderStore.get(flag.folderId)?.type, 'Actor');
    const rootId = folderStore.get(flag.folderId)?.folder;
    assert.ok(rootId, 'encounter Actor Folder is nested under a shared root');
    assert.equal(folderStore.get(rootId)?.name, 'SheetDelver');
    assert.equal(folderStore.get(rootId)?.type, 'Actor');
    assert.deepEqual((folderStore.get(rootId)?.flags as any)?.world?.sheetDelverCombatRoot, { schemaVersion: 1 });

    await assert.rejects(() => combatManagerService.rename(player, combatId, 'Unauthorized'),
        (error: unknown) => error instanceof CombatManagerError && error.status === 403);
    const renameCollision = await combatManagerService.create(gm, 'Reserved label', false);
    await assert.rejects(() => combatManagerService.rename(gm, combatId, 'Reserved label'),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    await combatManagerService.destroy(gm, renameCollision.id);
    const renamed = await combatManagerService.rename(gm, combatId, 'Bridge at dusk');
    assert.equal(renamed.label, 'Bridge at dusk');
    assert.equal(folderStore.get(flag.folderId)?.name, 'Combat: Bridge at dusk');
    folderStore.applyModifyDocument('Folder', 'update', [{ _id: flag.folderId,
        'flags.world.sheetDelverCombatFolder.combatId': 'OTHER' }]);
    await assert.rejects(() => combatManagerService.rename(gm, combatId, 'Unsafe rename'),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    folderStore.applyModifyDocument('Folder', 'update', [{ _id: flag.folderId,
        'flags.world.sheetDelverCombatFolder.combatId': combatId }]);
    await assert.rejects(() => combatManagerService.create(gm, 'BRIDGE AT DUSK', false),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409);

    await combatManagerService.addWorldActor(gm, combatId, 'WORLDNPC');
    assert.equal((await combatManagerService.detail(gm, combatId)).participants[0].img, 'npc.webp',
        'roster uses the linked Actor portrait');
    await assert.rejects(() => combatManagerService.addWorldActor(gm, combatId, 'WORLDNPC'),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    const managedTurns = createCombatService({});
    assert.deepEqual(await managedTurns.rollInitiative(gm, combatId,
        (await combatManagerService.detail(gm, combatId)).participants[0].id, {}),
    { error: 'Use the GM Combat Manager to roll initiative', status: 403 },
    'legacy single-roll route cannot bypass the manager batch guard');
    assert.deepEqual(await managedTurns.advanceTurn(gm, combatId),
        { error: 'Use the GM Combat Manager to advance this encounter', status: 403 });
    assert.deepEqual(await managedTurns.advanceTurn(gm, combatId, true),
        { error: 'No eligible scored, unskipped combatants', status: 409 });
    await combatManagerService.updateParticipant(gm, combatId,
        (await combatManagerService.detail(gm, combatId)).participants[0].id, { initiative: 0 });
    assert.deepEqual(await combatManagerService.turn(gm, combatId,
        () => managedTurns.advanceTurn(gm, combatId, true)), { success: true, round: 1, turn: 0 });
    assert.equal(combatStore.get(combatId)?.active, true, 'Begin activates the Foundry Combat');
    await assert.rejects(() => combatManagerService.rename(gm, combatId, 'Too late'),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    assert.deepEqual(await combatManagerService.turn(gm, combatId,
        () => managedTurns.previousTurn(gm, combatId, true)), { success: true, round: 0, turn: 0 });
    assert.equal(combatStore.get(combatId)?.active, false, 'rewinding to unstarted deactivates the Combat');
    await combatManagerService.turn(gm, combatId, () => managedTurns.advanceTurn(gm, combatId, true));
    await assert.rejects(() => combatManagerService.turn(player, combatId,
        () => managedTurns.advanceTurn(player, combatId, true)),
    (error: unknown) => error instanceof CombatManagerError && error.status === 403);
    assert.equal((await combatManagerService.detail(gm, combatId)).participants[0].source, 'world');
    assert.equal((await combatManagerService.detail(gm, combatId)).participants[0].actorId, 'WORLDNPC');
    assert.equal(calls.filter(call => call.type === 'Actor' && call.action === 'create').length, 0,
        'world NPC is linked, never copied');

    assert.equal(parseActorPickerSort('{'), null, 'malformed sort is rejected');
    assert.equal(parseActorPickerSort(JSON.stringify({ nameDirection: 'asc', fields: Array.from({ length: 4 }, (_, index) => ({
        path: `system.field${index}`, direction: 'asc',
    })) })), null, 'the sort stack is limited to three Actor stats');
    assert.equal(parseActorPickerSort(JSON.stringify({ nameDirection: 'asc', fields: [
        { path: '__proto__.bad', direction: 'asc' },
    ] })), null, 'unsafe sort path is rejected');
    const sortable = [
        { _id: 'A', name: 'Beta', system: { level: 2, challenge: 3 } },
        { _id: 'B', name: 'Alpha', system: { level: 2, challenge: 4 } },
        { _id: 'C', name: 'Gamma', system: { level: 1, challenge: 4 } },
    ];
    const catalog = discoverActorSortFields(sortable);
    assert.deepEqual(sortActorChoices(sortable, { nameDirection: 'asc', fields: [
        { path: 'system.level', direction: 'desc' }, { path: 'system.challenge', direction: 'desc' },
    ] }, catalog, row => row._id)?.map(row => row._id), ['B', 'A', 'C'],
    'stat sort priority and per-field direction precede the Name tie-breaker');
    const byName = combatManagerService.worldActors(gm, '');
    assert.deepEqual(byName.actors.map(choice => choice.id), ['ASSISTANTNPC', 'WORLDNPC', 'PLAYERPC'],
        'world results are name-ordered before projection');
    assert.ok(byName.sortFields.some(field => field.path === 'system.attributes.hp.value'));
    const byHp = combatManagerService.worldActors(gm, '', JSON.stringify({ nameDirection: 'desc', fields: [
        { path: 'system.attributes.hp.value', direction: 'desc' },
    ] }));
    assert.equal(byHp.actors[0].id, 'WORLDNPC');
    assert.deepEqual(byHp.actors.slice(1).map(choice => choice.id), ['PLAYERPC', 'ASSISTANTNPC'],
        'missing stat values stay last, with Name as the tie-breaker');
    assert.throws(() => combatManagerService.worldActors(gm, '', JSON.stringify({ nameDirection: 'asc', fields: [
        { path: 'system.notPresent', direction: 'asc' },
    ] })), (error: unknown) => error instanceof CombatManagerError && error.status === 400);
    const packChoices = await combatManagerService.packActors(gm, 'test.monsters', 'ogre');
    assert.deepEqual(packChoices.actors.map(choice => choice.id), ['PACK1']);
    assert.ok(packChoices.sortFields.some(field => field.path === 'system.attributes.hp.value'));
    const sortedPack = await combatManagerService.packActors(gm, 'test.sort-pack', '', JSON.stringify({
        nameDirection: 'asc', fields: [{ path: 'system.details.level', direction: 'asc' }],
    }));
    assert.equal(sortedPack.actors.length, 1000);
    assert.deepEqual(sortedPack.actors.slice(0, 2).map(choice => choice.id), ['SORT1000', 'SORT0999'],
        'server sorts the complete pack without dropping choices');
    assert.equal(sortedPack.actors.at(-1)?.id, 'SORT0001', 'the last sorted pack Actor is still selectable');
    assert.ok(calls.some(call => call.operation.pack === 'test.sort-pack' && call.operation.indexFields.includes('system')),
        'the index requests source stats for catalog discovery');
    const writesBeforeInvalidQuantity = calls.length;
    for (const invalid of [0, 21, 1.5, '2']) {
        await assert.rejects(() => combatManagerService.addPackActor(gm, combatId, 'test.monsters', 'PACK1', invalid),
            (error: unknown) => error instanceof CombatManagerError && error.status === 400);
    }
    assert.equal(calls.length, writesBeforeInvalidQuantity, 'invalid quantities fail before any Foundry request');
    await combatManagerService.addPackActor(gm, combatId, 'test.monsters', 'PACK1', 2);
    const roster = (await combatManagerService.detail(gm, combatId)).participants;
    const copies = roster.filter(row => row.source === 'compendium-copy');
    assert.deepEqual(copies.map(row => row.actorId).sort(), ['COPY1', 'COPY2']);
    assert.deepEqual(copies.map(row => row.name).sort(), ['World-Sized Ogre #1', 'World-Sized Ogre #2']);
    assert.deepEqual(copies.map(row => row.img), ['ogre.webp', 'ogre.webp'],
        'roster uses each copied Actor portrait');
    const otherEncounter = await combatManagerService.create(gm, 'Second encounter', false);
    assert.equal(folderStore.get(readCombatManagerFlag(combatStore.get(otherEncounter.id))!.folderId!)?.folder, rootId,
        'later encounters reuse the same parent Actor Folder');
    assert.equal(folderStore.list().filter(folder => folder.name === 'SheetDelver').length, 1);
    actorStore.applyModifyDocument('Actor', 'update', [{ _id: copies[0].actorId, folder: null }]);
    assert.ok(!combatManagerService.worldActors(gm, '').actors.some(actor => copies.some(copy => copy.actorId === actor.id)),
        'encounter-owned pack copies never appear as world-link choices, even if moved out of the Folder');
    const combatantCreates = calls.filter(call => call.type === 'Combatant' && call.action === 'create').length;
    await assert.rejects(() => combatManagerService.addWorldActor(gm, otherEncounter.id, copies[0].actorId),
        (error: unknown) => error instanceof CombatManagerError && error.status === 404);
    assert.equal(calls.filter(call => call.type === 'Combatant' && call.action === 'create').length, combatantCreates,
        'direct API request cannot link an encounter-owned copy into another Combat');
    actorStore.applyModifyDocument('Actor', 'update', [{ _id: copies[0].actorId, folder: flag.folderId }]);
    await combatManagerService.complete(gm, otherEncounter.id);
    assert.equal((await combatManagerService.detail(gm, combatId)).currentCombatantId, 'ROW1',
        'adding rows mid-round preserves the current world NPC');
    await combatManagerService.updateParticipant(gm, combatId, copies[0].id, { initiative: 30 });
    const initiativeWrites = calls.filter(call => call.type === 'Combatant' && call.action === 'update').length;
    await assert.rejects(() => combatManagerService.updateParticipant(gm, combatId, copies[0].id,
        { initiative: 29, expectedInitiative: null }),
    (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    assert.equal(calls.filter(call => call.type === 'Combatant' && call.action === 'update').length, initiativeWrites,
        'stale manual initiative does not dispatch a Foundry write');
    await combatManagerService.updateParticipant(gm, combatId, copies[0].id,
        { initiative: 29, expectedInitiative: 30 });
    assert.equal('expectedInitiative' in calls.filter(call => call.type === 'Combatant' && call.action === 'update').at(-1)!.operation.updates[0], false,
        'Store precondition is never forwarded to Foundry');
    assert.equal((await combatManagerService.detail(gm, combatId)).participants.find(row => row.id === copies[0].id)?.initiative, 29);
    assert.equal((await combatManagerService.detail(gm, combatId)).currentCombatantId, 'ROW1',
        'initiative reorder preserves the current Combatant identity');
    assert.equal(actorStore.get('COPY1')?.folder, flag.folderId);
    assert.equal((actorStore.get('COPY1') as any)?.flags?.world?.sheetDelverCombatCopy?.sourceUuid,
        'Compendium.test.monsters.Actor.PACK1');
    assert.equal(copies[0].resource?.value, 18);
    const observedCopy = { actorId: copies[0].actorId, path: copies[0].resource!.path, value: copies[0].resource!.value };
    await assert.rejects(() => combatManagerService.updateResource(player, combatId, copies[0].id,
        { value: 7, expected: observedCopy }), (error: unknown) => error instanceof CombatManagerError && error.status === 403);
    await assert.rejects(() => combatManagerService.updateResource(gm, combatId, copies[0].id, { value: 7 }),
        (error: unknown) => error instanceof CombatManagerError && error.status === 400);
    await combatManagerService.updateResource(gm, combatId, copies[0].id, { value: 7, expected: observedCopy });
    assert.equal(((actorStore.get(copies[0].actorId)?.system as any).attributes.hp.value), 7);
    assert.equal(((actorStore.get(copies[1].actorId)?.system as any).attributes.hp.value), 18);
    assert.equal(((actorStore.get('WORLDNPC')?.system as any).attributes.hp.value), 31);
    const actorWrites = () => calls.filter(call => call.type === 'Actor' && call.action === 'update').length;
    const writeCount = actorWrites();
    await assert.rejects(() => combatManagerService.updateResource(gm, combatId, copies[0].id,
        { value: 6, expected: observedCopy }), (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    assert.equal(actorWrites(), writeCount, 'stale observed value must not dispatch a write');
    await assert.rejects(() => combatManagerService.updateResource(gm, combatId, copies[0].id,
        { value: 6, expected: { ...observedCopy, actorId: copies[1].actorId } }),
    (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    assert.equal(actorWrites(), writeCount, 'mismatched Actor identity must not dispatch a write');
    settingStore.applyModifyDocument('Setting', 'update', [{ _id: 'TRACKER', value: JSON.stringify({ resource: 'attributes.hp.max' }) }]);
    await assert.rejects(() => combatManagerService.updateResource(gm, combatId, copies[0].id,
        { value: 6, expected: { ...observedCopy, value: 7 } }),
    (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    assert.equal(actorWrites(), writeCount, 'changed tracker path must not dispatch a write');
    settingStore.applyModifyDocument('Setting', 'update', [{ _id: 'TRACKER', value: JSON.stringify({ resource: 'attributes.missing' }) }]);
    await assert.rejects(() => combatManagerService.updateResource(gm, combatId, copies[0].id,
        { value: 6, expected: { ...observedCopy, value: 7 } }),
    (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    assert.equal(actorWrites(), writeCount, 'missing source-backed resource must not dispatch a write');
    settingStore.applyModifyDocument('Setting', 'update', [{ _id: 'TRACKER', value: JSON.stringify({ resource: 'attributes.hp' }) }]);
    combatStore.applyModifyDocument('Combatant', 'update', [{ _id: copies[0].id, actorId: copies[1].actorId }],
        { parentUuid: `Combat.${combatId}` });
    await assert.rejects(() => combatManagerService.updateResource(gm, combatId, copies[0].id,
        { value: 6, expected: { ...observedCopy, value: 7 } }),
    (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    assert.equal(actorWrites(), writeCount, 'rebound Combatant must not dispatch a write');
    combatStore.applyModifyDocument('Combatant', 'update', [{ _id: copies[0].id, actorId: copies[0].actorId }],
        { parentUuid: `Combat.${combatId}` });
    actorStore.applyModifyDocument('Actor', 'update', [{ _id: copies[0].actorId, 'system.attributes.hp.value': 6 }]);
    await assert.rejects(() => combatManagerService.updateResource(gm, combatId, copies[0].id,
        { value: 5, expected: { ...observedCopy, value: 7 } }),
    (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    assert.equal(actorWrites(), writeCount, 'external Actor update must reject stale resource edit');
    await combatManagerService.updateResource(gm, combatId, copies[0].id,
        { value: 5, expected: { ...observedCopy, value: 6 } });
    assert.equal(((actorStore.get(copies[0].actorId)?.system as any).attributes.hp.value), 5);

    actorStore.applyModifyDocument('Actor', 'create', [{ _id: 'UNRELATED', name: 'Unrelated', folder: flag.folderId }]);
    await assert.rejects(() => combatManagerService.complete(gm, combatId), (error: unknown) =>
        error instanceof CombatManagerError && error.status === 409 && error.message.includes('unrelated'));
    assert.equal(readCombatManagerFlag(combatStore.get(combatId))?.status, 'cleaning');
    assert.ok(actorStore.get('COPY1'), 'preflight prevents any partial deletion');
    actorStore.applyModifyDocument('Actor', 'update', [{ _id: 'UNRELATED', folder: null }]);
    sceneStore.applyModifyDocument('Scene', 'create', [{ _id: 'SCENE1', tokens: [{ _id: 'TOKEN1', actorId: 'COPY1' }] }]);
    await assert.rejects(() => combatManagerService.complete(gm, combatId), (error: unknown) =>
        error instanceof CombatManagerError && error.status === 409 && error.message.includes('outside this Combat'));
    sceneStore.applyModifyDocument('Scene', 'delete', ['SCENE1']);
    assert.deepEqual(await combatManagerService.complete(gm, combatId), { completed: true, retained: false });
    assert.equal(combatStore.get(combatId), null);
    assert.equal(folderStore.get(flag.folderId), null);
    assert.ok(folderStore.get(rootId), 'empty SheetDelver root is retained for future encounters');
    assert.equal(actorStore.get('COPY1'), null);
    assert.equal(actorStore.get('COPY2'), null);
    assert.ok(actorStore.get('WORLDNPC'), 'linked world NPC survives encounter cleanup');

    const quantityEncounter = await combatManagerService.create(gm, 'Pack quantity', false);
    await combatManagerService.addPackActor(gm, quantityEncounter.id, 'test.monsters', 'PACK1', 3);
    const quantityRows = (await combatManagerService.detail(gm, quantityEncounter.id)).participants;
    assert.deepEqual(quantityRows.map(row => row.name).sort(), [
        'World-Sized Ogre #1', 'World-Sized Ogre #2', 'World-Sized Ogre #3',
    ]);
    assert.equal(new Set(quantityRows.map(row => row.actorId)).size, 3, 'each requested copy has its own world Actor');
    await combatManagerService.removeParticipant(gm, quantityEncounter.id, quantityRows.find(row => row.name.endsWith('#3'))!.id);
    await combatManagerService.addPackActor(gm, quantityEncounter.id, 'test.monsters', 'PACK1', 1);
    assert.ok((await combatManagerService.detail(gm, quantityEncounter.id)).participants.some(row => row.name === 'World-Sized Ogre #4'),
        'removing a Combatant does not reuse its allocated display number');
    assert.deepEqual(await combatManagerService.complete(gm, quantityEncounter.id), { completed: true, retained: false });

    const partialQuantity = await combatManagerService.create(gm, 'Partial pack quantity', false);
    let rowWrites = 0;
    const failingClient = { ...gm, dispatchDocument: async (...args: Parameters<CombatClientLike['dispatchDocument']>) => {
        if (args[0] === 'Combatant' && args[1] === 'create' && ++rowWrites === 2) throw new Error('synthetic row failure');
        return gm.dispatchDocument(...args);
    } } as CombatClientLike;
    await assert.rejects(() => combatManagerService.addPackActor(failingClient, partialQuantity.id, 'test.monsters', 'PACK1', 3),
        (error: unknown) => error instanceof CombatManagerError && error.status === 502
            && error.message.includes('Added 1 of 3 copies'));
    assert.equal((await combatManagerService.detail(gm, partialQuantity.id)).participants.length, 1,
        'a partial add reports completed rows and never retries the batch');
    assert.equal(readCombatManagerFlag(combatStore.get(partialQuantity.id))?.copyIds.length, 2,
        'the copy without a Combatant remains marked for safe cleanup');
    assert.deepEqual(await combatManagerService.complete(gm, partialQuantity.id), { completed: true, retained: false });

    const retained = await combatManagerService.create(gm, 'Historical encounter', true);
    await combatManagerService.addWorldActor(gm, retained.id, 'WORLDNPC');
    assert.deepEqual(await combatManagerService.complete(gm, retained.id), { completed: true, retained: true });
    assert.equal((await combatManagerService.detail(gm, retained.id)).status, 'completed');
    await assert.rejects(() => combatManagerService.create(gm, 'HISTORICAL ENCOUNTER', false),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409,
        'retained history also reserves its encounter name');
    await assert.rejects(() => combatManagerService.addWorldActor(gm, retained.id, 'WORLDNPC'),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    assert.deepEqual(await managedTurns.advanceTurn(gm, retained.id),
        { error: 'Encounter is not active', status: 409 },
        'legacy turn endpoint cannot mutate retained history');
    assert.deepEqual(await managedTurns.advanceTurn(assistant, retained.id),
        { error: 'Encounter is not active', status: 409 },
        'Assistant also cannot mutate retained history through legacy turn endpoint');
    await assert.rejects(() => combatManagerService.resetInitiative(gm, retained.id),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    const retainedRowId = (await combatManagerService.detail(gm, retained.id)).participants[0].id;
    await assert.rejects(() => combatManagerService.rollInitiativeOne(gm, retained.id, retainedRowId,
        async () => ({ success: true, initiative: 1 })),
    (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    assert.ok(actorStore.get('WORLDNPC'));

    const batch = await combatManagerService.create(gm, 'Initiative batch', false);
    await combatManagerService.addWorldActor(gm, batch.id, 'WORLDNPC');
    await combatManagerService.addWorldActor(gm, batch.id, 'PLAYERPC');
    await combatManagerService.addWorldActor(gm, batch.id, 'ASSISTANTNPC');
    const batchRoster = (await combatManagerService.detail(gm, batch.id)).participants;
    assert.equal(batchRoster.find(row => row.actorId === 'WORLDNPC')?.isNpc, true);
    assert.equal(batchRoster.find(row => row.actorId === 'PLAYERPC')?.isNpc, false);
    assert.equal(batchRoster.find(row => row.actorId === 'ASSISTANTNPC')?.isNpc, true,
        'assistant ownership does not make an Actor player-owned');
    await combatManagerService.setPlayerActions(gm, batch.id, { initiativeOpen: true });
    const formingPlayerTracker = (await managedTurns.listCombats(player)).combats.find(combat => combat.id === batch.id)!;
    assert.equal(formingPlayerTracker.active, false, 'player initiative does not activate Foundry Combat');
    assert.ok(formingPlayerTracker.playerInitiative?.generation);
    assert.deepEqual(formingPlayerTracker.combatants, [], 'pending Actors are separate from the turn roster');
    assert.deepEqual(formingPlayerTracker.initiativeCandidates?.map(row => row.actorId), ['PLAYERPC'],
        'forming phase prompts only the caller-owned visible Actor');
    assert.equal(formingPlayerTracker.initiativeCandidates![0].canRollInitiative, true);
    let currentBeforeBatch = (await combatManagerService.detail(gm, batch.id)).currentCombatantId;
    const rolledIds: string[] = [];
    const rollOne = async (rowId: string) => {
        rolledIds.push(rowId);
        combatStore.applyModifyDocument('Combatant', 'update', [{ _id: rowId, initiative: rolledIds.length * 10 }],
            { parentUuid: `Combat.${batch.id}` });
        return { success: true as const, initiative: rolledIds.length * 10 };
    };
    await assert.rejects(() => combatManagerService.rollInitiativeBatch(player, batch.id, 'npc', rollOne),
        (error: unknown) => error instanceof CombatManagerError && error.status === 403);
    await assert.rejects(() => combatManagerService.rollInitiativeBatch(gm, batch.id, 'invalid', rollOne),
        (error: unknown) => error instanceof CombatManagerError && error.status === 400);
    assert.equal(rolledIds.length, 0, 'role and scope preflights have no roll side effects');
    const originalBatchResolve = combatStatDisplayService.resolve;
    let initiativePreferenceReads = 0;
    const fallbackSnapshots: Array<string | null> = [];
    combatStatDisplayService.resolve = async client => {
        initiativePreferenceReads++;
        return originalBatchResolve(client);
    };
    const npcBatch = await (async () => {
        try {
            return await combatManagerService.rollInitiativeBatch(gm, batch.id, 'npc', (rowId, fallback) => {
                fallbackSnapshots.push(fallback);
                return rollOne(rowId);
            });
        } finally {
            combatStatDisplayService.resolve = originalBatchResolve;
        }
    })();
    assert.equal(initiativePreferenceReads, 2,
        'one preference read selects batch formulas; one projects the response');
    assert.deepEqual(fallbackSnapshots, [null, null], 'every batch roll receives the same fallback snapshot');
    assert.equal(npcBatch.rolled, 2);
    assert.deepEqual(rolledIds.sort(), batchRoster.filter(row => row.isNpc).map(row => row.id).sort());
    assert.equal(npcBatch.encounter.currentCombatantId, currentBeforeBatch,
        'batch initiative reordering preserves the active Combatant');
    assert.equal((await combatManagerService.rollInitiativeBatch(gm, batch.id, 'npc', rollOne)).rolled, 0,
        'NPC batch skips rows that already rolled');
    await combatManagerService.turn(gm, batch.id, () => managedTurns.advanceTurn(gm, batch.id, true));
    currentBeforeBatch = (await combatManagerService.detail(gm, batch.id)).currentCombatantId;
    assert.equal(readCombatManagerFlag(combatStore.get(batch.id))?.playerActions?.initiativeOpen, false,
        'Begin atomically closes the player phase');
    const allBatch = await combatManagerService.rollInitiativeBatch(gm, batch.id, 'all', rollOne);
    assert.equal(allBatch.rolled, 1);
    assert.equal(rolledIds.at(-1), batchRoster.find(row => row.actorId === 'PLAYERPC')?.id);
    assert.equal((await combatManagerService.rollInitiativeBatch(gm, batch.id, 'all', rollOne)).rolled, 0,
        'Roll All also skips rows that already rolled');
    for (const [client, canManage] of [[gm, true], [assistant, true], [player, false]] as const) {
        const tracker = (await managedTurns.listCombats(client)).combats.find(combat => combat.id === batch.id)!;
        assert.ok(tracker);
        assert.equal(tracker.canManage, canManage);
        assert.equal(tracker.canAdvanceTurn, false);
        assert.equal(tracker.canRewindTurn, false);
        assert.ok(tracker.combatants.every(row => !row.canRollInitiative));
    }
    const playerTracker = (await managedTurns.listCombats(player)).combats.find(combat => combat.id === batch.id)!;
    assert.equal(playerTracker.combatants.find(row => row.actorId === 'PLAYERPC')?.isOwned, true);
    const npcRowId = batchRoster.find(row => row.actorId === 'WORLDNPC')!.id;
    const playerRowId = batchRoster.find(row => row.actorId === 'PLAYERPC')!.id;
    const rollsBeforeSingle = rolledIds.length;
    await assert.rejects(() => combatManagerService.rollInitiativeOne(player, batch.id, npcRowId, rollOne),
        (error: unknown) => error instanceof CombatManagerError && error.status === 403);
    await assert.rejects(() => combatManagerService.rollInitiativeOne(gm, 'UNMARKED', npcRowId, rollOne),
        (error: unknown) => error instanceof CombatManagerError && error.status === 404);
    await assert.rejects(() => combatManagerService.rollInitiativeOne(gm, batch.id, 'NOTAROW', rollOne),
        (error: unknown) => error instanceof CombatManagerError && error.status === 404);
    assert.equal(rolledIds.length, rollsBeforeSingle, 'rejected single rolls have no chat or document side effects');
    const rerolled = await combatManagerService.rollInitiativeOne(gm, batch.id, npcRowId, rollOne);
    assert.equal(rerolled.rolled, 1);
    assert.equal(rolledIds.at(-1), npcRowId);
    assert.equal(rerolled.encounter.currentCombatantId, currentBeforeBatch,
        'single reroll preserves the active Combatant after sorting');
    await combatManagerService.updateParticipant(gm, batch.id, playerRowId, { initiative: null });
    assert.equal((await combatManagerService.detail(gm, batch.id)).participants.find(row => row.id === playerRowId)?.initiative, null,
        'per-row Clear uses the guarded manager participant update');
    await assert.rejects(() => combatManagerService.resetInitiative(player, batch.id),
        (error: unknown) => error instanceof CombatManagerError && error.status === 403);
    await assert.rejects(() => combatManagerService.resetInitiative(gm, 'UNMARKED'),
        (error: unknown) => error instanceof CombatManagerError && error.status === 404);
    const reset = await combatManagerService.resetInitiative(gm, batch.id);
    assert.equal(reset.cleared, 2);
    assert.ok(reset.encounter.participants.every(row => row.initiative === null));
    assert.equal(reset.encounter.currentCombatantId, null, 'Reset all pauses rather than selecting an unrolled Actor');
    assert.equal(reset.encounter.awaitingInitiative, true);
    assert.equal((await combatManagerService.resetInitiative(gm, batch.id)).cleared, 0,
        'an already cleared encounter dispatches no further updates');
    assert.deepEqual(await combatManagerService.complete(gm, batch.id), { completed: true, retained: false });

    const partial = await combatManagerService.create(gm, 'Partial initiative batch', false);
    await combatManagerService.addWorldActor(gm, partial.id, 'WORLDNPC');
    await combatManagerService.addWorldActor(gm, partial.id, 'ASSISTANTNPC');
    const currentBeforePartial = (await combatManagerService.detail(gm, partial.id)).currentCombatantId;
    let attempted = 0;
    await assert.rejects(() => combatManagerService.rollInitiativeBatch(gm, partial.id, 'npc', async rowId => {
        if (++attempted === 2) throw new Error('Synthetic roll failure');
        combatStore.applyModifyDocument('Combatant', 'update', [{ _id: rowId, initiative: 25 }],
            { parentUuid: `Combat.${partial.id}` });
        return { success: true as const, initiative: 25 };
    }), (error: unknown) => error instanceof CombatManagerError && error.status === 502
        && error.message.includes('Rolled 1 of 2'));
    assert.equal((await combatManagerService.detail(gm, partial.id)).participants.filter(row => row.initiative !== null).length, 1);
    assert.equal((await combatManagerService.detail(gm, partial.id)).currentCombatantId, currentBeforePartial);
    assert.deepEqual(await combatManagerService.complete(gm, partial.id), { completed: true, retained: false });

    // An interrupted creation can leave a marked provisional Combat whose
    // Folder exists but whose Folder ID was not yet saved on the Combat.
    combatStore.applyModifyDocument('Combat', 'create', [{ _id: 'INTERRUPTED', scene: null,
        flags: { world: { sheetDelverCombat: { schemaVersion: 1, mode: 'tokenless',
            label: 'Interrupted', status: 'provisioning', keepHistory: true,
            folderId: null, copyIds: [] } } }, combatants: [],
    }]);
    folderStore.applyModifyDocument('Folder', 'create', [{ _id: 'RECOVERED', type: 'Actor',
        flags: { world: { sheetDelverCombatFolder: { combatId: 'INTERRUPTED' } } },
    }]);
    assert.deepEqual(await combatManagerService.complete(gm, 'INTERRUPTED'), { completed: true, retained: false });
    assert.equal(folderStore.get('RECOVERED'), null);
    assert.equal(combatStore.get('INTERRUPTED'), null);

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-manager-stat-integration-'));
    const previousWorld = worldStateStore.getGameDataSnapshot();
    let previousDataDir: string | null = null;
    try { previousDataDir = getDataDir(); } catch { /* Standalone focused run has no data directory. */ }
    try {
        __resetDataDirForTests(dataDir);
        worldStateStore.seed({ world: { id: 'stat-world' }, system: { id: 'test' } } as any);
        preparedActorStore.bind(actorStore);
        preparedActorStore.configure(new BaseSystemAdapter(), { worldEpoch: 1, systemId: 'test' });
        preparedActorStore.rebuildAll();
        const ownerEncounter = await combatManagerService.create(gm, 'Owner participation', false);
        await combatManagerService.addWorldActor(gm, ownerEncounter.id, 'PLAYERPC');
        await combatManagerService.setPlayerActions(gm, ownerEncounter.id, { initiativeOpen: true });
        const ownerService = createCombatService({});
        const ownerView = (await ownerService.listCombats(player)).combats.find(combat => combat.id === ownerEncounter.id)!;
        const ownerRow = ownerView.initiativeCandidates![0];
        assert.equal(ownerView.active, false);
        assert.equal(ownerRow.canRollInitiative, true);
        const ownerObserved = { initiative: null, formula: ownerRow.initiativeRoll!.formula,
            phaseGeneration: ownerView.playerInitiative!.generation };
        const rollCount = playerRolls.length;
        const rolled = await ownerService.rollInitiative(player, ownerEncounter.id, ownerRow.id,
            { manualTotal: 12.5, observed: ownerObserved });
        assert.deepEqual(rolled, { success: true, initiative: 12.5 });
        assert.deepEqual(playerRolls.slice(rollCount), ['12.5']);
        assert.equal((await ownerService.rollInitiative(player, ownerEncounter.id, ownerRow.id,
            { manualTotal: 15, observed: ownerObserved }) as any).status, 409,
        'the first applied score wins across duplicate owner attempts');
        assert.equal(playerRolls.length, rollCount + 1, 'stale player request produces no second chat roll');
        await combatManagerService.updateParticipant(gm, ownerEncounter.id, ownerRow.id,
            { initiative: null, expectedInitiative: 12.5 });
        await combatManagerService.setPlayerActions(gm, ownerEncounter.id, { initiativeOpen: false });
        await combatManagerService.setPlayerActions(gm, ownerEncounter.id, { initiativeOpen: true });
        assert.equal((await ownerService.rollInitiative(player, ownerEncounter.id, ownerRow.id,
            { manualTotal: 15, observed: ownerObserved }) as any).status, 409,
        'a reopened phase rejects an older generation');
        const reopened = (await ownerService.listCombats(player)).combats.find(combat => combat.id === ownerEncounter.id)!;
        const reopenedObserved = { ...ownerObserved, phaseGeneration: reopened.playerInitiative!.generation };
        await combatManagerService.updateParticipant(gm, ownerEncounter.id, ownerRow.id, { hidden: true });
        assert.equal((await ownerService.listCombats(player)).combats.find(combat => combat.id === ownerEncounter.id), undefined);
        assert.deepEqual(await ownerService.rollInitiative(player, ownerEncounter.id, ownerRow.id,
            { manualTotal: 15, observed: reopenedObserved }), { error: 'Combatant not found', status: 404 });
        await combatManagerService.updateParticipant(gm, ownerEncounter.id, ownerRow.id, { hidden: false });
        const writesBeforeLoss = calls.length;
        actorStore.applyModifyDocument('Actor', 'update', [{ _id: 'PLAYERPC', ownership: { default: 0, player: 0 } }]);
        assert.deepEqual(await ownerService.rollInitiative(player, ownerEncounter.id, ownerRow.id,
            { manualTotal: 15, observed: reopenedObserved }), { error: 'Combatant not found', status: 404 });
        assert.equal(calls.length, writesBeforeLoss, 'ownership loss has no remote side effect');
        actorStore.applyModifyDocument('Actor', 'update', [{ _id: 'PLAYERPC', ownership: { player: 3 } }]);
        const staleClient = { ...player, getActor: async (id: string) => {
            worldStateStore.clearRuntimeState();
            return actorStore.get(id);
        } } as CombatClientLike;
        assert.equal((await ownerService.rollInitiative(staleClient, ownerEncounter.id, ownerRow.id,
            { manualTotal: 15, observed: reopenedObserved }) as any).status, 409,
        'world replacement during a remote read stops before rolling');
        worldStateStore.seed({ world: { id: 'stat-world' }, system: { id: 'test' } } as any);
        const secondRoll = await ownerService.rollInitiative(player, ownerEncounter.id, ownerRow.id,
            { manualTotal: 15, observed: reopenedObserved });
        assert.deepEqual(secondRoll, { success: true, initiative: 15 });
        assert.equal((await combatManagerService.detail(gm, ownerEncounter.id)).playerActions.scored, 1);
        await combatManagerService.updateParticipant(gm, ownerEncounter.id, ownerRow.id,
            { initiative: null, expectedInitiative: 15 });
        const partialClient = { ...player, dispatchDocument: async (type: string, action: string,
            operation?: unknown, parent?: { type: string; id: string }) => {
            if (type === 'Combatant' && action === 'update') throw new Error('synthetic score-write failure');
            return player.dispatchDocument(type, action, operation, parent);
        } } as CombatClientLike;
        const partialRoll = await ownerService.rollInitiative(partialClient, ownerEncounter.id, ownerRow.id,
            { manualTotal: 18, observed: reopenedObserved });
        assert.ok('error' in partialRoll && partialRoll.code === 'ROLL_OUTCOME_UNKNOWN',
            'chat-created score failure reports an uncertain outcome, never a successful roll');
        assert.equal((await combatManagerService.detail(gm, ownerEncounter.id)).participants[0].initiative, null);
        await combatManagerService.updateParticipant(gm, ownerEncounter.id, ownerRow.id,
            { initiative: 15, expectedInitiative: null });
        await combatManagerService.turn(gm, ownerEncounter.id, () => ownerService.advanceTurn(gm, ownerEncounter.id, true));
        const startedOwnerView = (await ownerService.listCombats(player)).combats.find(combat => combat.id === ownerEncounter.id)!;
        assert.equal(startedOwnerView.playerInitiative, undefined);
        assert.equal(startedOwnerView.canAdvanceTurn, true, 'owning player can end the managed current turn by default');
        const turnObserved = { active: startedOwnerView.active, started: startedOwnerView.started,
            round: startedOwnerView.round, currentCombatantId: startedOwnerView.currentCombatantId };
        assert.deepEqual(await ownerService.advanceTurn(player, ownerEncounter.id, false, turnObserved),
            { success: true, round: 2, turn: 0 });
        await combatManagerService.setPlayerActions(gm, ownerEncounter.id, { endTurnEnabled: false });
        assert.equal((await ownerService.advanceTurn(player, ownerEncounter.id, false, turnObserved) as any).status, 403);
        await combatManagerService.updateParticipant(gm, ownerEncounter.id, ownerRow.id,
            { initiative: null, expectedInitiative: 15 });
        await assert.rejects(() => combatManagerService.setPlayerActions(gm, ownerEncounter.id, { initiativeOpen: true }),
            (error: unknown) => error instanceof CombatManagerError && error.status === 409,
            'manual initiative toggles are pre-start only');
        const lateView = (await ownerService.listCombats(player)).combats.find(combat => combat.id === ownerEncounter.id)!;
        const lateObserved = { initiative: null, formula: lateView.initiativeCandidates![0].initiativeRoll!.formula,
            phaseGeneration: lateView.playerInitiative!.generation };
        const turnWritesBeforeRace = calls.filter(call => call.type === 'Combat' && call.action === 'update'
            && call.operation.updates?.[0]?.turn !== undefined).length;
        const concurrentTurnClient = { ...player, dispatchDocument: async (type: string, action: string,
            operation?: unknown, parent?: { type: string; id: string }) => {
            const result = await player.dispatchDocument(type, action, operation, parent);
            if (type === 'Combatant' && action === 'update') {
                combatStore.applyModifyDocument('Combat', 'update', [{ _id: ownerEncounter.id, round: 3 }]);
            }
            return result;
        } } as CombatClientLike;
        const racedRoll = await ownerService.rollInitiative(concurrentTurnClient, ownerEncounter.id, ownerRow.id,
            { manualTotal: 14, observed: lateObserved });
        assert.ok('error' in racedRoll && racedRoll.code === 'TURN_SYNC_UNKNOWN',
            'a concurrent GM turn change cannot be overwritten after the score write');
        assert.equal(calls.filter(call => call.type === 'Combat' && call.action === 'update'
            && call.operation.updates?.[0]?.turn !== undefined).length, turnWritesBeforeRace);
        assert.equal((await combatManagerService.detail(gm, ownerEncounter.id)).participants[0].initiative, 14,
            'turn-sync uncertainty does not hide the successfully applied score');
        const withCopy = await combatManagerService.addPackActor(gm, ownerEncounter.id, 'test.monsters', 'PACK1', 1);
        const generatedCopy = withCopy.participants.find(row => row.source === 'compendium-copy')!;
        assert.equal(generatedCopy.name, 'World-Sized Ogre #1', 'GM retains distinct generated labels');
        assert.equal(generatedCopy.hidden, true, 'late copied NPC starts hidden');
        await combatManagerService.updateParticipant(gm, ownerEncounter.id, generatedCopy.id, { hidden: false, initiative: 2 });
        const copiedPlayerView = (await ownerService.listCombats(player)).combats.find(combat => combat.id === ownerEncounter.id)!;
        assert.equal(copiedPlayerView.combatants.find(row => row.id === generatedCopy.id)?.name, 'World-Sized Ogre',
            'players never see a generated ordinal gap');
        combatStore.applyModifyDocument('Combatant', 'update', [{ _id: generatedCopy.id, name: 'Authored Ogre' }],
            { parentUuid: `Combat.${ownerEncounter.id}` });
        const renamedPlayerView = (await ownerService.listCombats(player)).combats.find(combat => combat.id === ownerEncounter.id)!;
        assert.equal(renamedPlayerView.combatants.find(row => row.id === generatedCopy.id)?.name, 'Authored Ogre',
            'authored Combatant names are not stripped');
        await combatManagerService.complete(gm, ownerEncounter.id);
        const hp = { key: 'hp', label: 'HP', path: 'system.attributes.hp', kind: 'resource' as const, showInRoster: true };
        assert.equal((await combatManagerService.saveStatPreferences(gm, [hp])).source, 'saved');
        assert.deepEqual((await combatManagerService.detail(gm, retained.id)).participants[0].stats,
            [{ title: 'HP', value: 31, subValue: '/ 31', showInRoster: true }]);
        actorStore.applyModifyDocument('Actor', 'update', [{ _id: 'WORLDNPC', 'system.attributes.hp.value': 24 }]);
        assert.equal((await combatManagerService.detail(gm, retained.id)).participants[0].stats[0]?.value, 24,
            'linked Actor changes refresh the configured stat');
        const preferences = await combatManagerService.statPreferences(gm, undefined, true);
        assert.equal(preferences.source, 'saved');
        assert.ok(preferences.available.some(field => field.path === 'system.attributes.hp'),
            'GM can choose Actor fields without first selecting a combatant');
        const editableHp = { ...hp, editable: true as const, health: true as const };
        await combatManagerService.saveStatPreferences(gm, [editableHp]);
        const editableEncounter = await combatManagerService.create(gm, 'Editable stats', false);
        await combatManagerService.addWorldActor(gm, editableEncounter.id, 'WORLDNPC');
        await combatManagerService.addPackActor(gm, editableEncounter.id, 'test.monsters', 'PACK1');
        const editRoster = (await combatManagerService.detail(gm, editableEncounter.id)).participants;
        const linked = editRoster.find(row => row.source === 'world')!;
        const copied = editRoster.find(row => row.source === 'compendium-copy')!;
        assert.equal(linked.stats[0]?.health, true);
        assert.deepEqual(linked.stats[0]?.edit, { key: 'hp', path: 'system.attributes.hp.value', value: 24, max: 31 });
        assert.deepEqual(copied.stats[0]?.edit, { key: 'hp', path: 'system.attributes.hp.value', value: 18, max: 20 });
        const expectedLinked = { actorId: linked.actorId, path: linked.stats[0].edit!.path,
            value: linked.stats[0].edit!.value };
        const statWrites = calls.filter(call => call.type === 'Actor' && call.action === 'update').length;
        await assert.rejects(() => combatManagerService.updateStat(player, editableEncounter.id,
            linked.id, 'hp', { value: 20, expected: expectedLinked }),
        (error: unknown) => error instanceof CombatManagerError && error.status === 403);
        await assert.rejects(() => combatManagerService.updateStat(gm, editableEncounter.id,
            linked.id, 'hp', { value: 20, expected: { ...expectedLinked, path: 'system.attributes.hp.max' } }),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409);
        await assert.rejects(() => combatManagerService.updateStat(gm, editableEncounter.id,
            linked.id, 'hp', { value: 20, expected: { ...expectedLinked, actorId: copied.actorId } }),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409);
        assert.equal(calls.filter(call => call.type === 'Actor' && call.action === 'update').length, statWrites);
        await combatManagerService.updateStat(gm, editableEncounter.id, linked.id, 'hp',
            { value: 20, expected: expectedLinked });
        assert.equal(((actorStore.get('WORLDNPC')?.system as any).attributes.hp.value), 20);
        assert.equal(((actorStore.get(copied.actorId)?.system as any).attributes.hp.value), 18,
            'a linked world edit does not change a compendium copy');
        await assert.rejects(() => combatManagerService.updateStat(gm, editableEncounter.id,
            linked.id, 'hp', { value: 19, expected: expectedLinked }),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409);
        await combatManagerService.saveStatPreferences(gm, [hp]);
        await assert.rejects(() => combatManagerService.updateStat(gm, editableEncounter.id,
            linked.id, 'hp', { value: 19, expected: { ...expectedLinked, value: 20 } }),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409);
        await combatManagerService.saveStatPreferences(gm, [editableHp]);
        const expectedCopy = { actorId: copied.actorId, path: copied.stats[0].edit!.path,
            value: copied.stats[0].edit!.value };
        await combatManagerService.updateStat(gm, editableEncounter.id, copied.id, 'hp',
            { value: 12, expected: expectedCopy });
        assert.equal(((actorStore.get(copied.actorId)?.system as any).attributes.hp.value), 12);
        assert.equal(((actorStore.get('WORLDNPC')?.system as any).attributes.hp.value), 20);
        await combatManagerService.addPackActor(gm, editableEncounter.id, 'test.monsters', 'PACK1');
        const thirdCopy = (await combatManagerService.detail(gm, editableEncounter.id)).participants.find(row =>
            row.source === 'compendium-copy' && row.actorId !== copied.actorId)!;
        const healthTargets = [
            { combatantId: linked.id, statKey: 'hp', expected: { ...expectedLinked, value: 20 } },
            { combatantId: copied.id, statKey: 'hp', expected: { ...expectedCopy, value: 12 } },
            { combatantId: thirdCopy.id, statKey: 'hp', expected: { actorId: thirdCopy.actorId,
                path: thirdCopy.stats[0].edit!.path, value: thirdCopy.stats[0].edit!.value } },
        ];
        await assert.rejects(() => combatManagerService.applyHealthBatch(player, editableEncounter.id,
            { operation: 'damage', amount: 3, targets: healthTargets }),
        (error: unknown) => error instanceof CombatManagerError && error.status === 403);
        await assert.rejects(() => combatManagerService.applyHealthBatch(gm, editableEncounter.id,
            { operation: 'damage', amount: 3, targets: [healthTargets[0], healthTargets[0]] }),
        (error: unknown) => error instanceof CombatManagerError && error.status === 400);
        await assert.rejects(() => combatManagerService.applyHealthBatch(gm, editableEncounter.id,
            { operation: 'damage', amount: 3, targets: [healthTargets[0], healthTargets[1],
                { ...healthTargets[2], expected: { ...healthTargets[2].expected, value: 999 } }] }),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409
            && error.message === 'Health changed; review the current value before retrying',
        'the batch rejects a stale third Actor before any write');
        assert.equal(((actorStore.get('WORLDNPC')?.system as any).attributes.hp.value), 20);
        assert.equal(((actorStore.get(copied.actorId)?.system as any).attributes.hp.value), 12);
        assert.equal(((actorStore.get(thirdCopy.actorId)?.system as any).attributes.hp.value), 18);
        let batchWrites = 0;
        const failingWriteClient: CombatClientLike = { ...gm,
            dispatchDocument: async (type, action, operation, parent) => {
                if (type === 'Actor' && action === 'update' && ++batchWrites === 2) {
                    throw new Error('Synthetic transport failure');
                }
                return gm.dispatchDocument(type, action, operation, parent);
            },
        };
        await assert.rejects(() => combatManagerService.applyHealthBatch(failingWriteClient, editableEncounter.id,
            { operation: 'damage', amount: 3, targets: healthTargets.slice(0, 2) }),
        (error: unknown) => error instanceof CombatManagerError && error.status === 502
            && error.message.startsWith('Applied 1 of 2:'),
        'a genuine write failure still reports partial application');
        assert.equal(((actorStore.get('WORLDNPC')?.system as any).attributes.hp.value), 17);
        assert.equal(((actorStore.get(copied.actorId)?.system as any).attributes.hp.value), 12);
        const originalResolve = combatStatDisplayService.resolve;
        let preferenceReads = 0;
        combatStatDisplayService.resolve = async client => {
            preferenceReads++;
            return originalResolve(client);
        };
        const healed = await (async () => {
            try {
                return await combatManagerService.applyHealthBatch(gm, editableEncounter.id,
                { operation: 'heal', amount: 2, targets: [
                    { ...healthTargets[0], expected: { ...healthTargets[0].expected, value: 17 } }, healthTargets[1],
                ] });
            } finally {
                combatStatDisplayService.resolve = originalResolve;
            }
        })();
        assert.equal(preferenceReads, 2, 'one preference read preflights the batch; one projects the response');
        assert.equal(healed.applied, 2);
        assert.equal(((actorStore.get('WORLDNPC')?.system as any).attributes.hp.value), 19);
        assert.equal(((actorStore.get(copied.actorId)?.system as any).attributes.hp.value), 14);
        await combatManagerService.complete(gm, editableEncounter.id);
        const retainedCombatantId = (await combatManagerService.detail(gm, retained.id)).participants[0].id;
        await assert.rejects(() => combatManagerService.applyHealthBatch(gm, retained.id,
            { operation: 'damage', amount: 1, targets: [{ ...healthTargets[0], combatantId: retainedCombatantId }] }),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409,
        'retained completed encounters reject area damage');
        await assert.rejects(() => combatManagerService.updateStat(gm, retained.id,
            retainedCombatantId, 'hp',
            { value: 9, expected: { ...expectedLinked, value: 20 } }),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409);
        assert.equal((await combatManagerService.resetStatPreferences(gm)).source, 'none');
        assert.deepEqual((await combatManagerService.detail(gm, retained.id)).participants[0].stats, []);
    } finally {
        preparedActorStore.clear();
        worldStateStore.clear();
        if (previousWorld) worldStateStore.seed(previousWorld);
        __resetDataDirForTests(previousDataDir);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
    combatStore.applyModifyDocument('Combat', 'update', [{ _id: retained.id,
        'flags.world.sheetDelverCombat.completedAt': '2020-01-01T00:00:00.000Z' }]);
    const newerHistory = await combatManagerService.create(gm, 'Newer history', true);
    assert.equal((await combatManagerService.list(gm))[0]?.id, newerHistory.id,
        'unfinished encounter appears before completed history');
    await combatManagerService.addPackActor(gm, newerHistory.id, 'test.monsters', 'PACK1');
    const historyCopy = (await combatManagerService.detail(gm, newerHistory.id)).participants[0].actorId;
    const historyFolder = readCombatManagerFlag(combatStore.get(newerHistory.id))!.folderId!;
    await combatManagerService.complete(gm, newerHistory.id);
    const historyIds = (await combatManagerService.list(gm)).filter(row => row.status === 'completed').map(row => row.id);
    assert.deepEqual(historyIds.slice(0, 2), [newerHistory.id, retained.id], 'completed history is newest first');
    await assert.rejects(() => combatManagerService.destroy(player, newerHistory.id),
        (error: unknown) => error instanceof CombatManagerError && error.status === 403);
    sceneStore.applyModifyDocument('Scene', 'create', [{ _id: 'HISTORYSCENE', tokens: [{ _id: 'HISTORYTOKEN', actorId: historyCopy }] }]);
    await assert.rejects(() => combatManagerService.destroy(gm, newerHistory.id),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    assert.equal(readCombatManagerFlag(combatStore.get(newerHistory.id))?.deletionRequested, true);
    assert.equal((await combatManagerService.detail(gm, newerHistory.id)).deletionRequested, true);
    assert.ok(actorStore.get(historyCopy), 'unsafe history removal leaves the copy untouched');
    sceneStore.applyModifyDocument('Scene', 'delete', ['HISTORYSCENE']);
    assert.deepEqual(await combatManagerService.destroy(gm, newerHistory.id), { deleted: true });
    assert.equal(combatStore.get(newerHistory.id), null);
    assert.equal(folderStore.get(historyFolder), null);
    assert.equal(actorStore.get(historyCopy), null);
    assert.ok(actorStore.get('WORLDNPC'), 'removing history never deletes a linked world Actor');
    assert.deepEqual(await combatManagerService.destroy(gm, retained.id), { deleted: true });
    const abandoned = await combatManagerService.create(gm, 'Abandoned draft', true);
    await combatManagerService.addWorldActor(gm, abandoned.id, 'WORLDNPC');
    await combatManagerService.addPackActor(gm, abandoned.id, 'test.monsters', 'PACK1');
    await combatManagerService.updateParticipant(gm, abandoned.id,
        (await combatManagerService.detail(gm, abandoned.id)).participants[0].id, { initiative: 0 });
    await combatManagerService.turn(gm, abandoned.id, () => managedTurns.advanceTurn(gm, abandoned.id, true));
    assert.equal(combatStore.get(abandoned.id)?.active, true);
    const abandonedCopy = (await combatManagerService.detail(gm, abandoned.id)).participants
        .find(row => row.source === 'compendium-copy')!.actorId;
    const abandonedFolder = readCombatManagerFlag(combatStore.get(abandoned.id))!.folderId!;
    sceneStore.applyModifyDocument('Scene', 'create', [{ _id: 'ABANDONEDSCENE', tokens: [{ _id: 'ABANDONEDTOKEN', actorId: abandonedCopy }] }]);
    await assert.rejects(() => combatManagerService.destroy(gm, abandoned.id),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    assert.equal(readCombatManagerFlag(combatStore.get(abandoned.id))?.deletionRequested, true);
    assert.equal((await combatManagerService.detail(gm, abandoned.id)).status, 'cleaning');
    assert.equal(combatStore.get(abandoned.id)?.active, false);
    await assert.rejects(() => combatManagerService.complete(gm, abandoned.id),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409,
        'a failed explicit deletion cannot fall back into the Keep for history completion path');
    assert.ok(actorStore.get(abandonedCopy), 'failed deletion retains the guarded copy');
    sceneStore.applyModifyDocument('Scene', 'delete', ['ABANDONEDSCENE']);
    assert.deepEqual(await combatManagerService.destroy(gm, abandoned.id), { deleted: true });
    assert.equal(combatStore.get(abandoned.id), null);
    assert.equal(folderStore.get(abandonedFolder), null);
    assert.equal(actorStore.get(abandonedCopy), null);
    assert.ok(actorStore.get('WORLDNPC'), 'destroying a draft never deletes its linked world Actor');
    const reusedName = await combatManagerService.create(gm, 'Abandoned draft', false);
    await combatManagerService.destroy(gm, reusedName.id);
    combatStore.applyModifyDocument('Combat', 'create', [{ _id: 'OLDREMOVAL', scene: null, active: false,
        flags: { world: { sheetDelverCombat: { schemaVersion: 1, mode: 'tokenless',
            label: 'Older removal', status: 'cleaning', keepHistory: true,
            folderId: null, copyIds: [], historyRemovalRequested: true } } }, combatants: [],
    }]);
    assert.deepEqual(await combatManagerService.destroy(gm, 'OLDREMOVAL'), { deleted: true },
        'an interrupted removal from the earlier history-only path remains retryable');
    folderStore.applyModifyDocument('Folder', 'delete', [rootId]);
    folderStore.applyModifyDocument('Folder', 'create', [{ _id: 'USERROOT', name: 'SheetDelver', type: 'Actor', folder: null }]);
    const reusedRootEncounter = await combatManagerService.create(gm, 'Existing root', false);
    assert.equal(folderStore.get(readCombatManagerFlag(combatStore.get(reusedRootEncounter.id))!.folderId!)?.folder,
        'USERROOT', 'a unique existing top-level Actor Folder is reused without taking ownership');
    await combatManagerService.complete(gm, reusedRootEncounter.id);
    assert.ok(folderStore.get('USERROOT'), 'cleanup never deletes a reused parent Folder');
    folderStore.applyModifyDocument('Folder', 'create', [{ _id: 'DUPROOT', name: 'SheetDelver', type: 'Actor', folder: null }]);
    const createdCombats = calls.filter(call => call.type === 'Combat' && call.action === 'create').length;
    await assert.rejects(() => combatManagerService.create(gm, 'Ambiguous root', false),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    assert.equal(calls.filter(call => call.type === 'Combat' && call.action === 'create').length, createdCombats,
        'ambiguous parent folders fail before creating a provisional Combat');
    folderStore.applyModifyDocument('Folder', 'delete', ['DUPROOT', 'USERROOT']);
    await runManagedQueueRefinements();
    await runManagedSkipRefinements();
    await runParticipationHardening();
    await runInitiativeOverrideValidation();
    console.log('  - CombatManager: role, identity, resource, retention and cleanup checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().then(() => console.log('combat-manager.test.ts passed'));
}
