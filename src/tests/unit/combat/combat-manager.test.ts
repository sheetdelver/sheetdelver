import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { combatManagerService, CombatManagerError } from '@server/services/combats/CombatManagerService';
import { discoverActorSortFields, parseActorPickerSort, sortActorChoices } from '@server/services/combats/CombatActorPickerSort';
import { combatStatDisplayService, projectCombatStatFields } from '@server/services/combats/CombatStatDisplayService';
import { readCombatManagerFlag } from '@server/services/combats/combatManagerFlag';
import { createCombatService } from '@server/services/combats/CombatService';
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

type Call = { type: string; action: string; operation: Record<string, any>; parent?: { type: string; id: string } };

function mockClient(userId: string, calls: Call[]): CombatClientLike {
    let combatNumber = 0;
    let folderNumber = 0;
    let actorNumber = 0;
    let combatantNumber = 0;
    return {
        userId,
        getSystem: async () => ({ id: 'test' }),
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

async function seed(): Promise<void> {
    await userStore.seed(async () => [
        { _id: 'gm', role: 4 }, { _id: 'assistant', role: 3 }, { _id: 'player', role: 1 },
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
    const player = mockClient('player', calls);

    for (const restricted of [assistant, player]) {
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

    await assert.rejects(() => combatManagerService.rename(assistant, combatId, 'Unauthorized'),
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
    const managedTurns = createCombatService({ normalizeActors: async actors => actors });
    assert.deepEqual(await managedTurns.rollInitiative(gm, combatId,
        (await combatManagerService.detail(gm, combatId)).participants[0].id, {}),
    { error: 'Use the GM Combat Manager to roll initiative', status: 403 },
    'legacy single-roll route cannot bypass the manager batch guard');
    assert.deepEqual(await managedTurns.advanceTurn(gm, combatId),
        { error: 'Use the GM Combat Manager to advance this encounter', status: 403 });
    assert.deepEqual(await combatManagerService.turn(gm, combatId,
        () => managedTurns.advanceTurn(gm, combatId, true)), { success: true, round: 1, turn: 0 });
    assert.equal(combatStore.get(combatId)?.active, true, 'Begin activates the Foundry Combat');
    await assert.rejects(() => combatManagerService.rename(gm, combatId, 'Too late'),
        (error: unknown) => error instanceof CombatManagerError && error.status === 409);
    assert.deepEqual(await combatManagerService.turn(gm, combatId,
        () => managedTurns.previousTurn(gm, combatId, true)), { success: true, round: 0, turn: 0 });
    assert.equal(combatStore.get(combatId)?.active, false, 'rewinding to unstarted deactivates the Combat');
    await combatManagerService.turn(gm, combatId, () => managedTurns.advanceTurn(gm, combatId, true));
    await assert.rejects(() => combatManagerService.turn(assistant, combatId,
        () => managedTurns.advanceTurn(assistant, combatId, true)),
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
    await assert.rejects(() => combatManagerService.updateResource(assistant, combatId, copies[0].id,
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
        { error: 'Gamemaster access required', status: 403 },
        'assistant cannot bypass manager restriction through legacy turn endpoint');
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
    await combatManagerService.turn(gm, batch.id, () => managedTurns.advanceTurn(gm, batch.id, true));
    const currentBeforeBatch = (await combatManagerService.detail(gm, batch.id)).currentCombatantId;
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
    const allBatch = await combatManagerService.rollInitiativeBatch(gm, batch.id, 'all', rollOne);
    assert.equal(allBatch.rolled, 1);
    assert.equal(rolledIds.at(-1), batchRoster.find(row => row.actorId === 'PLAYERPC')?.id);
    assert.equal((await combatManagerService.rollInitiativeBatch(gm, batch.id, 'all', rollOne)).rolled, 0,
        'Roll All also skips rows that already rolled');
    const npcRowId = batchRoster.find(row => row.actorId === 'WORLDNPC')!.id;
    const playerRowId = batchRoster.find(row => row.actorId === 'PLAYERPC')!.id;
    const rollsBeforeSingle = rolledIds.length;
    await assert.rejects(() => combatManagerService.rollInitiativeOne(assistant, batch.id, npcRowId, rollOne),
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
    await assert.rejects(() => combatManagerService.resetInitiative(assistant, batch.id),
        (error: unknown) => error instanceof CombatManagerError && error.status === 403);
    await assert.rejects(() => combatManagerService.resetInitiative(gm, 'UNMARKED'),
        (error: unknown) => error instanceof CombatManagerError && error.status === 404);
    const reset = await combatManagerService.resetInitiative(gm, batch.id);
    assert.equal(reset.cleared, 2);
    assert.ok(reset.encounter.participants.every(row => row.initiative === null));
    assert.equal(reset.encounter.currentCombatantId, currentBeforeBatch,
        'Reset all preserves the active Combatant');
    assert.equal((await combatManagerService.resetInitiative(gm, batch.id)).cleared, 0,
        'an already cleared encounter dispatches no further updates');
    assert.deepEqual(await combatManagerService.complete(gm, batch.id), { completed: true, retained: false });

    const partial = await combatManagerService.create(gm, 'Partial initiative batch', false);
    await combatManagerService.addWorldActor(gm, partial.id, 'WORLDNPC');
    await combatManagerService.addWorldActor(gm, partial.id, 'ASSISTANTNPC');
    await combatManagerService.turn(gm, partial.id, () => managedTurns.advanceTurn(gm, partial.id, true));
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
        await assert.rejects(() => combatManagerService.updateStat(assistant, editableEncounter.id,
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
        await assert.rejects(() => combatManagerService.applyHealthBatch(assistant, editableEncounter.id,
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
    await assert.rejects(() => combatManagerService.destroy(assistant, newerHistory.id),
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
    console.log('  - CombatManager: role, identity, resource, retention and cleanup checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().then(() => console.log('combat-manager.test.ts passed'));
}
