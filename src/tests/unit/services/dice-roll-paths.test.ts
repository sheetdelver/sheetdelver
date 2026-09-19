import assert from 'node:assert/strict';
import { createSessionRouteFoundryClient } from '@server/shared/utils/createRouteFoundryClient';
import { createRollRuntime, createChatRuntime } from '@server/shared/utils/moduleDocumentServices';
import { createChatService } from '@server/services/chat/ChatService';
import { chatMessageStore } from '@server/core/documents/primary/chat-messages/ChatMessageStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { LiveDiceInbox, toDicePresentation } from '@client/ui/components/Dice/presentation';

/** Real host evaluation/serialization/projection, with only Foundry transport mocked. */
export async function run() {
    await userStore.seed(async () => [{ _id: 'player', name: 'Player', role: 1 }, { _id: 'gm', name: 'GM', role: 4 }, { _id: 'other', name: 'Other', role: 1 }]);
    await chatMessageStore.seed(async () => []);
    let sequence = 0;
    const createdIds: string[] = [];
    const client = createSessionRouteFoundryClient({
        userId: 'player',
        on() {}, off() {},
        dispatchDocument: async (type: string, action: string, operation: any) => {
            assert.equal(type, 'ChatMessage');
            assert.equal(action, 'create');
            return { result: operation.data.map((data: any) => {
                const _id = `roll-${++sequence}`;
                createdIds.push(_id);
                return { ...data, _id, timestamp: sequence, type: 'base' };
            }) };
        },
    } as any);
    const service = createChatService({ config: { app: { chatHistory: 100 } } as any });
    const rolls = createRollRuntime(client, async () => {});
    const chat = createChatRuntime(client, async () => {});
    try {
        await service.sendChatMessage(client as any, { message: '/r 1d20 + 2' });
        // This is the same request-bound client.roll called by ActorService.rollActor.
        await client.roll('1d20 + 2', 'Ability check', { rollMode: 'publicroll', speaker: { actor: 'hero', alias: 'Hero' } });
        await client.roll('2d20kh + 3', 'Weapon attack', { rollMode: 'publicroll', speaker: { actor: 'hero' } });
        await client.roll('1d8 + 1', 'Damage', { rollMode: 'publicroll' });
        const result = await rolls.roll('1d6 + 2');
        assert.equal(createdIds.length, 4, 'silent SDK evaluation does not invent a chat event');
        await chat.send({ content: 'SDK roll', rolls: result.rolls }, { rollMode: 'publicroll' });
        await rolls.roll('1d4', 'Posted SDK roll', { displayChat: true, rollMode: 'publicroll' });
        await chat.card({ title: 'SDK card', evaluatedRolls: result.rolls }, { rollMode: 'publicroll' });
        await chat.card({ content: 'Combined card', rolls: [{ formula: 'Display', total: 99 }], evaluatedRolls: result.rolls }, { rollMode: 'publicroll' });
        const payload = await service.getChatLog(client as any, 100);
        assert.equal(payload.messages.length, 8);
        const inbox = new LiveDiceInbox();
        assert.deepEqual(inbox.consume(payload.messages), [], 'history stays silent for every source');
        for (const id of createdIds) inbox.created(id);
        const presentations = inbox.consume(payload.messages);
        assert.equal(presentations.length, 8, 'tray, actor and SDK chat all reach the same presenter');
        for (const message of payload.messages) {
            const recorded = (message.rolls as any[]).flatMap(roll => roll.terms.filter((term: any) => term.class === 'Die').flatMap((term: any) => term.results.map((r: any) => r.result)));
            const presentation = toDicePresentation(message)!;
            assert.deepEqual(presentation.notation.split('@')[1].split(',').map(Number), recorded);
            assert.equal(presentation.authorId, 'player');
        }
        assert.deepEqual(inbox.consume(payload.messages), [], 'duplicate reads never replay card dice');
        await chat.card({ rolls: [{ formula: 'Summary', total: 99 }] });
        const summary = (await service.getChatLog(client as any, 100)).messages.at(-1)!;
        assert.equal(summary.isRoll, false);
        assert.equal(toDicePresentation(summary), null, 'summary-only cards are never animatable');
        for (const mode of ['selfroll', 'gmroll', 'blindroll'] as const) {
            await chat.card({ title: 'SECRET', rolls: [{ formula: 'SECRET', total: 99 }], evaluatedRolls: result.rolls }, { rollMode: mode, speaker: { alias: 'SECRET' } });
            for (const viewer of ['player', 'gm', 'other']) {
                const message = (await service.getChatLog({ userId: viewer } as any, 100)).messages.at(-1)!;
                const visible = mode === 'selfroll' ? viewer === 'player' : mode === 'blindroll' ? viewer === 'gm' : viewer !== 'other';
                assert.equal(message.isContentVisible, visible, mode + ': ' + viewer);
                if (!visible) {
                    assert.equal(message.flags, undefined);
                    assert.ok(!JSON.stringify(message).includes('SECRET'));
                    assert.equal(toDicePresentation(message), null);
                } else {
                    assert.equal(!!toDicePresentation(message), mode === 'gmroll', 'Self and Blind presentation policy stays unchanged');
                }
            }
        }
        await client.roll('1d20', 'Self check', { rollMode: 'selfroll' });
        const self = (await service.getChatLog(client as any, 100)).messages.at(-1)!;
        assert.equal(toDicePresentation(self), null, 'self-roll suppression applies to actor rolls too');
    } finally {
        chatMessageStore.clear('dice-roll-path-test');
        userStore.clear('dice-roll-path-test');
    }
    console.log('  - Shared roll paths to dice presentation: all checks passed');
}
