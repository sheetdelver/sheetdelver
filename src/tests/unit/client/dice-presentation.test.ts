import assert from 'node:assert/strict';
import { LiveDiceInbox, toDicePresentation } from '../../../client/ui/components/Dice/presentation';

export function run() {
    const message = {
        _id: 'roll-1', rolls: [{ evaluated: true, terms: [
            { class: 'Die', faces: 20, results: [{ result: 17, active: true }, { result: 3, active: false }] },
            { class: 'OperatorTerm', operator: '+' }, { class: 'NumericTerm', number: 5 },
        ] }],
    };
    assert.deepEqual(toDicePresentation(message), { id: 'roll-1', notation: '1d20+1d20@17,3' });
    assert.equal(toDicePresentation({ ...message, blind: true }), null);
    assert.equal(toDicePresentation({ ...message, isContentVisible: false }), null,
        'redacted placeholders never animate, even if incorrectly supplied roll data');
    const selfRoll = { ...message, author: 'author', whisper: ['author'], blind: false };
    assert.equal(toDicePresentation(selfRoll), null, 'self rolls remain chat-only for the author');
    assert.equal(toDicePresentation({ ...selfRoll, whisper: ['author', 'author'] }), null);
    assert.ok(toDicePresentation({ ...selfRoll, whisper: [] }), 'public rolls still animate');
    assert.ok(toDicePresentation({ ...selfRoll, whisper: ['author', 'gm'] }), 'authorized GM rolls still animate');
    assert.ok(toDicePresentation({ ...selfRoll, whisper: ['gm'] }), 'recipient whispers are not self rolls');
    assert.equal(toDicePresentation({ ...message, rolls: [] }), null);
    assert.equal(toDicePresentation({ ...message, rolls: [JSON.stringify(message.rolls[0])] }), null);
    const die = (faces: number, result: number, count = 1) => ({
        _id: 'die', rolls: [{ evaluated: true, terms: [{ class: 'Die', faces, results: Array(count).fill({ result }) }] }],
    });
    for (const faces of [4, 6, 8, 10, 12, 20]) {
        assert.equal(toDicePresentation(die(faces, faces))?.notation, `1d${faces}@${faces}`);
    }
    for (const value of [die(100, 101), die(100, 0), die(100, 1, 13), die(6, 7), die(6, 0), die(6, 1.5), die(6, NaN), die(6, 1, 25)]) {
        assert.equal(toDicePresentation(value), null);
    }
    assert.equal(toDicePresentation({ _id: 'nested', rolls: [{ evaluated: true, terms: [{ class: 'PoolTerm', rolls: message.rolls }] }] }), null);
    assert.equal(toDicePresentation({ ...message, rolls: [{ ...message.rolls[0], evaluated: false }] }), null);
    for (let value = 1; value <= 100; value++) {
        const output = toDicePresentation(die(100, value));
        assert.ok(output);
        assert.ok(output.notation.startsWith('1d100+1d10@'));
        const [tens, ones] = output.notation.split('@')[1].split(',').map(Number);
        assert.ok(tens >= 10 && tens <= 100 && tens % 10 === 0);
        assert.ok(ones >= 1 && ones <= 10);
        assert.equal(((tens % 100) + (ones % 10)) || 100, value);
    }
    for (const [value, faces] of [[1, '100,1'], [10, '10,10'], [42, '40,2'], [99, '90,9'], [100, '100,10']] as const) {
        assert.equal(toDicePresentation(die(100, value))?.notation, `1d100+1d10@${faces}`);
    }
    assert.equal(toDicePresentation(die(100, 50, 12))?.notation.split('@')[1].split(',').length, 24);
    const mixed = { _id: 'mixed', rolls: [{ evaluated: true, terms: [
        { class: 'Die', faces: 100, results: [{ result: 42 }] },
        { class: 'OperatorTerm', operator: '+' },
        { class: 'Die', faces: 6, results: [{ result: 5 }] },
    ] }] };
    assert.equal(toDicePresentation(mixed)?.notation, '1d100+1d10+1d6@40,2,5');
    assert.equal(toDicePresentation({ ...mixed, blind: true }), null);
    assert.equal(toDicePresentation({ _id: 'percentiles', rolls: [{ evaluated: true, terms: [
        { class: 'Die', faces: 100, results: [1, 10, 99, 100].map(result => ({ result })) },
    ] }] })?.notation, '1d100+1d100+1d100+1d100+1d10+1d10+1d10+1d10@100,10,90,100,1,10,9,10');
    assert.equal(toDicePresentation({ _id: 'interleaved', rolls: [{ evaluated: true, terms: [
        { class: 'Die', faces: 6, results: [{ result: 2 }] },
        { class: 'Die', faces: 20, results: [{ result: 17 }] },
        { class: 'Die', faces: 6, results: [{ result: 5 }] },
    ] }] })?.notation, '1d6+1d6+1d20@2,5,17');
    const selfInbox = new LiveDiceInbox();
    selfInbox.created('roll-1', 0);
    assert.deepEqual(selfInbox.consume([selfRoll], 1), [], 'live self rolls never enter the renderer queue');
    selfInbox.created('roll-1', 2);
    assert.deepEqual(selfInbox.consume([{ ...selfRoll, whisper: [] }], 3), [], 'suppressed self rolls do not replay');
    const inbox = new LiveDiceInbox();
    assert.deepEqual(inbox.consume([message], 0), [], 'history does not animate');
    inbox.created('roll-1', 0);
    assert.deepEqual(inbox.consume([], 1), [], 'wait for an authorized read');
    assert.equal(inbox.consume([message], 2).length, 1);
    inbox.created('roll-1', 3);
    assert.deepEqual(inbox.consume([message], 4), [], 'duplicate creates do not replay');
    inbox.reset();
    inbox.created('roll-1', 0);
    assert.deepEqual(inbox.consume([message], 10_001), [], 'expired events do not replay');
    inbox.created('roll-1', 11_000);
    inbox.reset();
    assert.deepEqual(inbox.consume([message], 11_001), [], 'logout/reconnect clears pending rolls');
    inbox.created('roll-1', 12_000);
    inbox.invalidated('roll-1');
    assert.deepEqual(inbox.consume([message], 12_001), [], 'changed/deleted messages cancel pending throws');
    inbox.created('roll-1', 12_002);
    assert.deepEqual(inbox.consume([{ ...message, blind: true }], 12_001), []);
}
