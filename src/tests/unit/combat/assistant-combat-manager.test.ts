import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockClient, seed } from './combat-manager.test';
import { ActorStore, actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { combatStore } from '@server/core/documents/primary/combats/CombatStore';
import { folderStore } from '@server/core/documents/primary/folders/FolderStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { preparedActorStore } from '@server/core/documents/prepared/actors/PreparedActorStore';
import { __resetDataDirForTests, getDataDir } from '@server/core/paths';
import { combatManagerService, CombatManagerError } from '@server/services/combats/CombatManagerService';
import { createCombatService } from '@server/services/combats/CombatService';
import { BaseSystemAdapter } from '@shared/sdk';
import { readCombatManagerFlag } from '@server/services/combats/combatManagerFlag';
import { ChatMessageStore } from '@server/core/documents/primary/chat-messages/ChatMessageStore';
import { SettingStore } from '@server/core/documents/primary/settings/SettingStore';
import { JournalStore } from '@server/core/documents/primary/journals/JournalStore';
import { ItemStore } from '@server/core/documents/primary/items/ItemStore';
import { createActorService } from '@server/services/actors/ActorService';
import { documentAudienceIncludes, type DocumentAudience } from '@server/core/documents/primary/base/audience';

export async function run() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-assistant-manager-'));
    const previousWorld = worldStateStore.getGameDataSnapshot();
    let previousDataDir: string | null = null;
    try { previousDataDir = getDataDir(); } catch { /* Standalone run. */ }
    try {
        __resetDataDirForTests(dataDir);
        await seed();
        worldStateStore.seed({ world: { id: 'assistant-fixture' }, system: { id: 'test' }, release: { generation: 14 } });
        preparedActorStore.bind(actorStore);
        preparedActorStore.configure(new BaseSystemAdapter(), { worldEpoch: 1, systemId: 'test' });
        preparedActorStore.rebuildAll();
        const calls: Parameters<typeof mockClient>[1] = [];
        const assistant = mockClient('assistant', calls);
        const gm = mockClient('gm', []);
        assert.ok(combatManagerService.worldActors(assistant, '').actors.some(row => row.id === 'WORLDNPC'));
        const created = await combatManagerService.create(assistant, 'Assistant encounter', false);
        const folderId = readCombatManagerFlag(combatStore.get(created.id))!.folderId!;
        const subject = userStore.createAccessSubject('assistant')!;
        assert.ok(folderStore.canReadDocument(folderId, subject, 3));
        assert.ok(combatStore.canReadDocument(created.id, subject, 3));
        await combatManagerService.rename(assistant, created.id, 'Assistant revised');
        await combatManagerService.addWorldActor(assistant, created.id, 'WORLDNPC');
        await combatManagerService.addPackActor(assistant, created.id, 'test.monsters', 'PACK1', 2);
        const hp = { key: 'hp', label: 'HP', path: 'system.attributes.hp', kind: 'resource' as const,
            editable: true, health: true };
        await combatManagerService.saveStatPreferences(assistant, [hp]);
        assert.deepEqual((await combatManagerService.statPreferences(gm)).attributes, [hp], 'GM/Assistant share preferences');
        let encounter = await combatManagerService.detail(assistant, created.id);
        const copied = encounter.participants.find(row => row.source === 'compendium-copy')!;
        assert.ok(actorStore.canReadActor(copied.actorId, subject, 3), 'default-private copies retain native Assistant capability');
        await combatManagerService.updateParticipant(assistant, created.id, copied.id, { hidden: true, defeated: true });
        assert.equal((await combatManagerService.detail(assistant, created.id)).participants.find(row => row.id === copied.id)?.hidden, true);
        await combatManagerService.updateStat(assistant, created.id, copied.id, 'hp',
            { value: 15, expected: { actorId: copied.actorId, path: copied.stats[0].edit!.path, value: 18 } });
        encounter = await combatManagerService.detail(assistant, created.id);
        const targets = encounter.participants.map(row => ({ combatantId: row.id, statKey: 'hp',
            expected: { actorId: row.actorId, path: row.stats[0].edit!.path, value: row.stats[0].edit!.value } }));
        assert.equal((await combatManagerService.applyHealthBatch(assistant, created.id,
            { operation: 'damage', amount: 2, targets })).applied, 3);
        const turns = createCombatService({ normalizeActors: async actors => actors });
        await combatManagerService.turn(assistant, created.id, () => turns.advanceTurn(assistant, created.id, true));
        assert.equal(combatStore.get(created.id)?.round, 1);
        await combatManagerService.resetInitiative(assistant, created.id);
        assert.equal((await combatManagerService.rollInitiativeBatch(assistant, created.id, 'npc', async rowId => {
            combatStore.applyModifyDocument('Combatant', 'update', [{ _id: rowId, initiative: 12 }], { parentUuid: `Combat.${created.id}` });
            return { success: true, initiative: 12 };
        })).rolled, 3);

        // Per-user transport identities are unchanged throughout the workflow.
        assert.equal(assistant.userId, 'assistant');
        const privateActor = actorStore.get(copied.actorId)!;
        const actorService = createActorService({ normalizeActors: async rows => rows,
            getPreparedActor: id => preparedActorStore.get(id)!, config: { debug: { level: 0 } } as any });
        const list = await actorService.listActors({ ...assistant, url: 'http://fixture.invalid',
            getActors: async () => [{ ...privateActor, type: 'character' }] } as any);
        assert.equal(list.ownedActors[0]?._id, copied.actorId, 'ActorService uses the same native capability as ActorStore');

        // Boundaries outside the explicitly corrected document types stay unchanged.
        const chat = new ChatMessageStore();
        const journals = new JournalStore();
        const items = new ItemStore();
        const settings = new SettingStore();
        await chat.seed(async () => [{ _id: 'private-chat', author: 'gm', whisper: ['player'], content: 'private' }]);
        await journals.seed(async () => [{ _id: 'private-journal', ownership: { default: 0 }, pages: [] }]);
        await items.seed(async () => [{ _id: 'private-item', ownership: { default: 0 } }]);
        await settings.seed(async () => [{ _id: 'world-config', key: 'test', value: 1 }]);
        assert.equal(chat.canReadDocument('private-chat', subject), false);
        assert.equal(journals.canReadDocument('private-journal', subject), false);
        assert.equal(items.canReadDocument('private-item', subject), false);
        assert.equal(settings.canReadDocument('world-config', subject), false);

        // Private Actor read capability and metadata invalidations use the same Store policy.
        const audienceActors = new ActorStore();
        await audienceActors.seed(async () => [privateActor]);
        audienceActors.bindAudienceSubjects(() => ['assistant', 'gm', 'player'].map(id => userStore.createAccessSubject(id)!));
        const audiences: DocumentAudience[] = [];
        const actorChanged = (event: { audience: DocumentAudience }) => audiences.push(event.audience);
        audienceActors.on('documentChanged', actorChanged);
        audienceActors.patch(copied.actorId, { name: 'Changed copy' });
        audienceActors.off('documentChanged', actorChanged);
        assert.equal(documentAudienceIncludes(audiences[0], 'assistant'), true);
        assert.equal(documentAudienceIncludes(audiences[0], 'player'), false);

        // v14 live configuration can hide packs from Assistant, but not full GM.
        settingStore.upsert({ _id: 'PACKCFG', key: 'core.compendiumConfiguration',
            value: { 'test.monsters': { ownership: { PLAYER: 'NONE', ASSISTANT: 'NONE' } } } });
        assert.equal(combatManagerService.packs(assistant).some(pack => pack.id === 'test.monsters'), false);
        assert.equal(combatManagerService.packs(gm).some(pack => pack.id === 'test.monsters'), true);
        const beforeDeniedPack = calls.length;
        await assert.rejects(() => combatManagerService.addPackActor(assistant, created.id, 'test.monsters', 'PACK1'),
            error => error instanceof CombatManagerError && error.status === 404);
        assert.equal(calls.length, beforeDeniedPack, 'pack denial precedes a read or write');
        worldStateStore.seed({ world: { id: 'assistant-fixture' }, system: { id: 'test' }, release: { generation: 13 } });
        assert.equal(combatManagerService.packs(assistant).some(pack => pack.id === 'test.monsters'), true, 'v13 pack override is native');
        userStore.patch('assistant', { permissions: { ACTOR_CREATE: false } });
        await assert.rejects(() => combatManagerService.addPackActor(assistant, created.id, 'test.monsters', 'PACK1'),
            error => error instanceof CombatManagerError && error.status === 403);
        assert.equal(calls.length, beforeDeniedPack, 'v13 create revocation is checked before reads/writes');
        userStore.patch('assistant', { permissions: { ACTOR_CREATE: true, FILES_BROWSE: false } });
        const wildcardClient = { ...assistant, dispatchDocument: async (...args: Parameters<typeof assistant.dispatchDocument>) => {
            const result = await assistant.dispatchDocument(...args) as any;
            if (args[0] === 'Actor' && args[1] === 'get') result.result[0].prototypeToken = { randomImg: true };
            return result;
        } };
        const beforeWildcardWrites = calls.filter(call => call.action !== 'get').length;
        await assert.rejects(() => combatManagerService.addPackActor(wildcardClient, created.id, 'test.monsters', 'PACK1'),
            error => error instanceof CombatManagerError && error.status === 403);
        assert.equal(calls.filter(call => call.action !== 'get').length, beforeWildcardWrites, 'wildcard denial precedes mutation');
        worldStateStore.seed({ world: { id: 'assistant-fixture' }, system: { id: 'test' }, release: { generation: 14 } });
        settingStore.upsert({ _id: 'PACKCFG', key: 'core.compendiumConfiguration',
            value: { 'test.monsters': { ownership: { PLAYER: 'NONE', ASSISTANT: 'OWNER' } } } });
        userStore.patch('assistant', { permissions: { ACTOR_CREATE: false, FILES_BROWSE: false } });
        await combatManagerService.addPackActor(wildcardClient, created.id, 'test.monsters', 'PACK1');
        userStore.patch('assistant', { role: 2 });
        const beforeDowngrade = calls.length;
        await assert.rejects(() => combatManagerService.destroy(assistant, created.id),
            error => error instanceof CombatManagerError && error.status === 403);
        assert.equal(calls.length, beforeDowngrade);
        assert.equal(actorStore.canReadActor(copied.actorId, userStore.createAccessSubject('assistant')!, 3), false);
        userStore.patch('assistant', { role: 3 });

        // A downgrade after the first accepted native write stops later batch targets.
        encounter = await combatManagerService.detail(assistant, created.id);
        let changedRole = false;
        const downgradeClient = { ...assistant, dispatchDocument: async (...args: Parameters<typeof assistant.dispatchDocument>) => {
            const result = await assistant.dispatchDocument(...args);
            if (!changedRole && args[0] === 'Actor' && args[1] === 'update') {
                changedRole = true;
                userStore.patch('assistant', { role: 2 });
            }
            return result;
        } };
        const batchTargets = encounter.participants.slice(0, 2).map(row => ({ combatantId: row.id, statKey: 'hp',
            expected: { actorId: row.actorId, path: row.stats[0].edit!.path, value: row.stats[0].edit!.value } }));
        await assert.rejects(() => combatManagerService.applyHealthBatch(downgradeClient, created.id,
            { operation: 'damage', amount: 1, targets: batchTargets }),
        error => error instanceof CombatManagerError && error.message.includes('Applied 1 of 2'));
        assert.equal((actorStore.get(batchTargets[1].expected.actorId)?.system as any).attributes.hp.value,
            batchTargets[1].expected.value, 'second target was not dispatched after downgrade');
        userStore.patch('assistant', { role: 3 });

        // Recheck after async scope lookup, before changing durable shared settings.
        await assert.rejects(() => combatManagerService.saveStatPreferences({ ...assistant, getSystem: async () => {
            userStore.patch('assistant', { role: 2 });
            return { id: 'test' };
        } } as any, []), error => error instanceof CombatManagerError && error.status === 403);
        userStore.patch('assistant', { role: 3 });
        assert.deepEqual((await combatManagerService.statPreferences(assistant)).attributes, [hp]);

        // Native write errors can interrupt cleanup; markers retain retry authority.
        const failingCleanup = { ...assistant, dispatchDocument: async (...args: Parameters<typeof assistant.dispatchDocument>) => {
            if (args[0] === 'Folder' && args[1] === 'delete') throw new Error('Synthetic cleanup failure');
            return assistant.dispatchDocument(...args);
        } };
        await assert.rejects(() => combatManagerService.complete(failingCleanup, created.id), /Synthetic cleanup failure/);
        assert.equal(readCombatManagerFlag(combatStore.get(created.id))?.status, 'cleaning');
        await combatManagerService.complete(assistant, created.id);
        assert.equal(combatStore.get(created.id), null);
        assert.equal(folderStore.get(folderId), null);
        assert.equal(actorStore.get(copied.actorId), null);
        assert.ok(actorStore.get('WORLDNPC'), 'cleanup never deletes linked world Actors');
        console.log('  - Assistant combat manager: native capabilities, lifecycle, pack/copy limits, downgrade and unchanged privacy checks passed');
    } finally {
        preparedActorStore.clear();
        worldStateStore.clear();
        if (previousWorld) worldStateStore.seed(previousWorld);
        __resetDataDirForTests(previousDataDir);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().catch(error => { console.error(error); process.exitCode = 1; });
}
