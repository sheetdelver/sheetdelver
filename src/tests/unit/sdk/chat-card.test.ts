import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { parseRollResult } from '@sheet-delver/sdk';
import type { ChatCard } from '@sheet-delver/sdk';
import type { RollResult } from '@sheet-delver/sdk/server';
import { createMockModuleRuntime } from '@sheet-delver/sdk/testing';
import { createChatCardMessage } from '@shared/sdk/chatCard';
import { createChatRuntime } from '@server/shared/utils/moduleDocumentServices';

const evaluated = {
    class: 'Roll', formula: '1d6', total: 0, evaluated: true,
    terms: [{ class: 'Die', number: 1, faces: 6, results: [{ result: 1, active: true }] }],
};
const json = JSON.stringify(evaluated);

export async function run() {
    const sent: Record<string, unknown>[] = [];
    const client = {
        userId: 'player',
        async createChatMessage(message: Record<string, unknown>) { sent.push(message); return message; },
    };
    const runtime = createChatRuntime(client as never, async () => {});
    const mock = createMockModuleRuntime();
    for (const card of [
        { title: 'Summary', rolls: [{ formula: '1d6', total: 0, flavor: 'Display' }] },
        { title: 'Recorded', evaluatedRolls: [json] },
        { content: '<b>Body</b>', flavor: 'Test', rolls: [{ formula: 'Summary', total: 99 }], evaluatedRolls: [json, json] },
        { title: 'Empty', rolls: [], evaluatedRolls: [] },
    ] satisfies ChatCard[]) {
        const original = structuredClone(card);
        const actual = await runtime.card(card) as Record<string, unknown>;
        const { _id, ...fake } = await mock.chat.card(card) as Record<string, unknown>;
        assert.ok(_id);
        const { author, ...withoutAuthor } = actual;
        assert.equal(author, 'player');
        assert.deepEqual(fake, withoutAuthor, 'mock and runtime use identical card serialization');
        assert.deepEqual(card, original, 'posting does not mutate the card');
        const flag = (actual.flags as { sheetDelver: { chatCard: ChatCard } }).sheetDelver.chatCard;
        assert.equal(flag.evaluatedRolls, undefined, 'recorded rolls are not duplicated into flags');
        if (card.evaluatedRolls?.length) assert.deepEqual(actual.rolls, card.evaluatedRolls);
        else assert.equal(actual.rolls, undefined, 'summaries must not become native rolls');
    }
    const before = sent.length;
    for (const card of [
        { rolls: [json] }, { rolls: null }, { rolls: [{ formula: '1d6', total: Infinity }] },
        { evaluatedRolls: [evaluated] }, { evaluatedRolls: 'bad' }, { evaluatedRolls: ['not json'] },
        { evaluatedRolls: [JSON.stringify({ formula: '1d6', total: 2 })] },
        { evaluatedRolls: [JSON.stringify({ ...evaluated, evaluated: false })] },
        { evaluatedRolls: [JSON.stringify({ ...evaluated, total: null })] },
        { evaluatedRolls: [JSON.stringify({ ...evaluated, terms: null })] },
        { evaluatedRolls: [json, 'bad second roll'] },
    ]) {
        const invalid = card as unknown as ChatCard;
        await assert.rejects(runtime.card(invalid), { code: 'validation', status: 400 });
        await assert.rejects(mock.chat.card(invalid), { code: 'validation', status: 400 });
    }
    assert.equal(sent.length, before, 'invalid cards never dispatch, including partially valid arrays');
    const gated = createChatRuntime(client as never, async () => { throw new Error('not ready'); });
    await assert.rejects(gated.card({ evaluatedRolls: [json] }), /not ready/);
    assert.equal(sent.length, before);

    for (const raw of [{ rolls: [json] }, { rolls: [evaluated] }, { roll: evaluated }, evaluated]) {
        const result: RollResult = parseRollResult(raw);
        assert.equal(result.total, 0);
        assert.equal(result.formula, '1d6');
        assert.deepEqual(result.rolls, [json]);
        const card: ChatCard = { rolls: [{ formula: result.formula, total: result.total }], evaluatedRolls: result.rolls };
        assert.deepEqual(createChatCardMessage(card).rolls, [json]);
    }
    const multi = parseRollResult({ rolls: [evaluated, { ...evaluated, class: 'DamageRoll', total: 6 }] });
    assert.equal(multi.rolls?.length, 2);
    assert.equal(JSON.parse(multi.rolls![1]).class, 'DamageRoll', 'native subclass metadata is retained');
    for (const rolls of [['bad'], [{ formula: '1d6', total: 2 }], [{ ...evaluated, evaluated: false }]]) {
        assert.equal(parseRollResult({ formula: '1d6', total: 2, rolls }).rolls, undefined, 'malformed data cannot supply dice faces');
    }
    assert.equal(parseRollResult({ formula: '1d6', total: 2 }).rolls, undefined);
    console.log('  - SDK chat card summary/recorded roll contract: all checks passed');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run().catch(error => { console.error(error); process.exitCode = 1; });
}
