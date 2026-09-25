import { strict as assert } from 'node:assert';
import { combatManagerService, CombatManagerError } from '@server/services/combats/CombatManagerService';
import { readCombatManagerFlag } from '@server/services/combats/combatManagerFlag';
import { createCombatService } from '@server/services/combats/CombatService';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { combatStore } from '@server/core/documents/primary/combats/CombatStore';
import { folderStore } from '@server/core/documents/primary/folders/FolderStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { sceneStore } from '@server/core/documents/primary/scenes/SceneStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { compendiumStore } from '@server/core/compendium/CompendiumStore';
import type { CombatClientLike } from '@server/shared/types/documents';
import type { ActorDocument } from '@server/shared/types/actors';

type Call = { type: string; action: string; operation: Record<string, any>; parent?: { type: string; id: string } };

function mockClient(userId: string, calls: Call[]): CombatClientLike {
    let combatNumber = 0;
    let folderNumber = 0;
    let actorNumber = 0;
    let combatantNumber = 0;
    return {
        userId,
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

async function seed(): Promise<void> {
    await userStore.seed(async () => [
        { _id: 'gm', role: 4 }, { _id: 'assistant', role: 3 }, { _id: 'player', role: 1 },
    ]);
    await actorStore.seed(async () => [{
        _id: 'WORLDNPC', name: 'Ongoing NPC', type: 'npc',
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
}

export async function run(): Promise<void> {
    await seed();
    const calls: Call[] = [];
    const gm = mockClient('gm', calls);
    const assistant = mockClient('assistant', calls);
    const player = mockClient('player', calls);

    for (const restricted of [assistant, player]) {
        assert.throws(() => combatManagerService.list(restricted), (error: unknown) => error instanceof CombatManagerError && error.status === 403);
        assert.throws(() => combatManagerService.worldActors(restricted, ''), (error: unknown) => error instanceof CombatManagerError && error.status === 403);
        await assert.rejects(() => combatManagerService.create(restricted, 'Forbidden', false), (error: unknown) => error instanceof CombatManagerError && error.status === 403);
    }
    assert.equal(calls.length, 0, 'role rejection occurs before Foundry writes');
    assert.throws(() => combatManagerService.detail(gm, 'UNMARKED'), (error: unknown) => error instanceof CombatManagerError && error.status === 404);
    assert.equal(readCombatManagerFlag({ scene: 'SCENE1', flags: { world: { sheetDelverCombat: {
        schemaVersion: 1, mode: 'tokenless', label: 'Scene encounter', status: 'active',
        keepHistory: false, folderId: null, copyIds: [],
    } } } }), null, 'scene-linked Combat is never adopted');

    const created = await combatManagerService.create(gm, 'Bridge ambush', false);
    assert.equal(created.status, 'active');
    assert.equal(created.keepHistory, false);
    const combatId = created.id;
    assert.equal(combatStore.get(combatId)?.active, false,
        'creating a manager encounter must not deactivate an existing Foundry Combat');
    const flag = readCombatManagerFlag(combatStore.get(combatId));
    assert.ok(flag?.folderId, 'dedicated Actor Folder recorded on the Combat');
    assert.equal(folderStore.get(flag.folderId)?.type, 'Actor');

    await combatManagerService.addWorldActor(gm, combatId, 'WORLDNPC');
    const managedTurns = createCombatService({ normalizeActors: async actors => actors });
    assert.deepEqual(await managedTurns.rollInitiative(gm, combatId,
        combatManagerService.detail(gm, combatId).participants[0].id, {}),
    { error: 'Use the GM Combat Manager to roll initiative', status: 403 },
    'legacy single-roll route cannot bypass the manager batch guard');
    assert.deepEqual(await managedTurns.advanceTurn(gm, combatId),
        { error: 'Use the GM Combat Manager to advance this encounter', status: 403 });
    assert.deepEqual(await combatManagerService.turn(gm, combatId,
        () => managedTurns.advanceTurn(gm, combatId, true)), { success: true, round: 1, turn: 0 });
    assert.equal(combatStore.get(combatId)?.active, true, 'Begin activates the Foundry Combat');
    assert.deepEqual(await combatManagerService.turn(gm, combatId,
        () => managedTurns.previousTurn(gm, combatId, true)), { success: true, round: 0, turn: 0 });
    assert.equal(combatStore.get(combatId)?.active, false, 'rewinding to unstarted deactivates the Combat');
    await combatManagerService.turn(gm, combatId, () => managedTurns.advanceTurn(gm, combatId, true));
    await assert.rejects(() => combatManagerService.turn(assistant, combatId,
        () => managedTurns.advanceTurn(assistant, combatId, true)),
    (error: unknown) => error instanceof CombatManagerError && error.status === 403);
    assert.equal(combatManagerService.detail(gm, combatId).participants[0].source, 'world');
    assert.equal(combatManagerService.detail(gm, combatId).participants[0].actorId, 'WORLDNPC');
    assert.equal(calls.filter(call => call.type === 'Actor' && call.action === 'create').length, 0,
        'world NPC is linked, never copied');

    const packChoices = await combatManagerService.packActors(gm, 'test.monsters', 'ogre');
    assert.deepEqual(packChoices.map(choice => choice.id), ['PACK1']);
    await combatManagerService.addPackActor(gm, combatId, 'test.monsters', 'PACK1');
    await combatManagerService.addPackActor(gm, combatId, 'test.monsters', 'PACK1');
    const roster = combatManagerService.detail(gm, combatId).participants;
    const copies = roster.filter(row => row.source === 'compendium-copy');
    assert.deepEqual(copies.map(row => row.actorId).sort(), ['COPY1', 'COPY2']);
    assert.equal(combatManagerService.detail(gm, combatId).currentCombatantId, 'ROW1',
        'adding rows mid-round preserves the current world NPC');
    await combatManagerService.updateParticipant(gm, combatId, copies[0].id, { initiative: 30 });
    assert.equal(combatManagerService.detail(gm, combatId).currentCombatantId, 'ROW1',
        'initiative reorder preserves the current Combatant identity');
    assert.equal(actorStore.get('COPY1')?.folder, flag.folderId);
    assert.equal((actorStore.get('COPY1') as any)?.flags?.world?.sheetDelverCombatCopy?.sourceUuid,
        'Compendium.test.monsters.Actor.PACK1');
    assert.equal(copies[0].resource?.value, 18);
    await combatManagerService.updateResource(gm, combatId, copies[0].id, 7);
    assert.equal(((actorStore.get(copies[0].actorId)?.system as any).attributes.hp.value), 7);
    assert.equal(((actorStore.get(copies[1].actorId)?.system as any).attributes.hp.value), 18);
    assert.equal(((actorStore.get('WORLDNPC')?.system as any).attributes.hp.value), 31);

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
    assert.equal(actorStore.get('COPY1'), null);
    assert.equal(actorStore.get('COPY2'), null);
    assert.ok(actorStore.get('WORLDNPC'), 'linked world NPC survives encounter cleanup');

    const retained = await combatManagerService.create(gm, 'Historical encounter', true);
    await combatManagerService.addWorldActor(gm, retained.id, 'WORLDNPC');
    assert.deepEqual(await combatManagerService.complete(gm, retained.id), { completed: true, retained: true });
    assert.equal(combatManagerService.detail(gm, retained.id).status, 'completed');
    await assert.rejects(() => combatManagerService.addWorldActor(gm, retained.id, 'WORLDNPC'),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    assert.deepEqual(await managedTurns.advanceTurn(gm, retained.id),
        { error: 'Encounter is not active', status: 409 },
        'legacy turn endpoint cannot mutate retained history');
    assert.deepEqual(await managedTurns.advanceTurn(assistant, retained.id),
        { error: 'Gamemaster access required', status: 403 },
        'assistant cannot bypass manager restriction through legacy turn endpoint');
    assert.ok(actorStore.get('WORLDNPC'));

    const batch = await combatManagerService.create(gm, 'Initiative batch', false);
    await combatManagerService.addWorldActor(gm, batch.id, 'WORLDNPC');
    await combatManagerService.addWorldActor(gm, batch.id, 'PLAYERPC');
    await combatManagerService.addWorldActor(gm, batch.id, 'ASSISTANTNPC');
    const batchRoster = combatManagerService.detail(gm, batch.id).participants;
    assert.equal(batchRoster.find(row => row.actorId === 'WORLDNPC')?.isNpc, true);
    assert.equal(batchRoster.find(row => row.actorId === 'PLAYERPC')?.isNpc, false);
    assert.equal(batchRoster.find(row => row.actorId === 'ASSISTANTNPC')?.isNpc, true,
        'assistant ownership does not make an Actor player-owned');
    await combatManagerService.turn(gm, batch.id, () => managedTurns.advanceTurn(gm, batch.id, true));
    const currentBeforeBatch = combatManagerService.detail(gm, batch.id).currentCombatantId;
    const rolledIds: string[] = [];
    const rollOne = async (rowId: string) => {
        rolledIds.push(rowId);
        combatStore.applyModifyDocument('Combatant', 'update', [{ _id: rowId, initiative: rolledIds.length * 10 }],
            { parentUuid: `Combat.${batch.id}` });
        return { success: true as const, initiative: rolledIds.length * 10 };
    };
    await assert.rejects(() => combatManagerService.rollInitiativeBatch(assistant, batch.id, 'npc', rollOne),
        (error: unknown) => error instanceof CombatManagerError && error.status === 403);
    await assert.rejects(() => combatManagerService.rollInitiativeBatch(gm, batch.id, 'invalid', rollOne),
        (error: unknown) => error instanceof CombatManagerError && error.status === 400);
    assert.equal(rolledIds.length, 0, 'role and scope preflights have no roll side effects');
    const npcBatch = await combatManagerService.rollInitiativeBatch(gm, batch.id, 'npc', rollOne);
    assert.equal(npcBatch.rolled, 2);
    assert.deepEqual(rolledIds.sort(), batchRoster.filter(row => row.isNpc).map(row => row.id).sort());
    assert.equal(npcBatch.encounter.currentCombatantId, currentBeforeBatch,
        'batch initiative reordering preserves the active Combatant');
    assert.equal((await combatManagerService.rollInitiativeBatch(gm, batch.id, 'npc', rollOne)).rolled, 0,
        'NPC batch skips rows that already rolled');
    const allBatch = await combatManagerService.rollInitiativeBatch(gm, batch.id, 'all', rollOne);
    assert.equal(allBatch.rolled, 1);
    assert.equal(rolledIds.at(-1), batchRoster.find(row => row.actorId === 'PLAYERPC')?.id);
    assert.equal((await combatManagerService.rollInitiativeBatch(gm, batch.id, 'all', rollOne)).rolled, 0,
        'Roll All also skips rows that already rolled');
    assert.deepEqual(await combatManagerService.complete(gm, batch.id), { completed: true, retained: false });

    const partial = await combatManagerService.create(gm, 'Partial initiative batch', false);
    await combatManagerService.addWorldActor(gm, partial.id, 'WORLDNPC');
    await combatManagerService.addWorldActor(gm, partial.id, 'ASSISTANTNPC');
    await combatManagerService.turn(gm, partial.id, () => managedTurns.advanceTurn(gm, partial.id, true));
    const currentBeforePartial = combatManagerService.detail(gm, partial.id).currentCombatantId;
    let attempted = 0;
    await assert.rejects(() => combatManagerService.rollInitiativeBatch(gm, partial.id, 'npc', async rowId => {
        if (++attempted === 2) throw new Error('Synthetic roll failure');
        combatStore.applyModifyDocument('Combatant', 'update', [{ _id: rowId, initiative: 25 }],
            { parentUuid: `Combat.${partial.id}` });
        return { success: true as const, initiative: 25 };
    }), (error: unknown) => error instanceof CombatManagerError && error.status === 502
        && error.message.includes('Rolled 1 of 2'));
    assert.equal(combatManagerService.detail(gm, partial.id).participants.filter(row => row.initiative !== null).length, 1);
    assert.equal(combatManagerService.detail(gm, partial.id).currentCombatantId, currentBeforePartial);
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
    console.log('  - CombatManager: role, identity, resource, retention and cleanup checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().then(() => console.log('combat-manager.test.ts passed'));
}
