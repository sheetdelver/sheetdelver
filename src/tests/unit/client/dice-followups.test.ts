import assert from 'node:assert/strict';
import { LiveDiceInbox, toDicePresentation } from '../../../client/ui/components/Dice/presentation';
import { allowsDicePresentation, defaultDiceBehavior, diceSoundForRoll } from '../../../client/ui/components/Dice/behavior';
import { nestedDiceMessage, recordedDie as die, recordedRoll as roll, recordedPool as pool,
    recordedParenthetical as parenthetical, recordedFunction as fn } from './fixtures/recorded-dice';

export function run() {
    const message = nestedDiceMessage();
    const present = (value: unknown) => toDicePresentation({ ...message, rolls: [value] });
    assert.equal(toDicePresentation(message)?.notation, '1d6+1d6+1d20+1d100+1d10@2,5,17,40,2');
    for (const container of [pool, fn]) {
        assert.equal(present(roll([container(roll([die(8, 7)]), roll([die(8, 3)]))]))?.notation, '1d8+1d8@7,3');
    }
    for (const [name, container] of [['DicePool', pool], ['MathTerm', fn]] as const) {
        assert.equal(present(roll([{ ...container(roll([die(6, 4)])), class: name }]))?.notation, '1d6@4');
    }
    assert.equal(present(roll([parenthetical(roll([die(4, 3)]))]))?.notation, '1d4@3');
    assert.equal(present(roll([{ class: 'NumericTerm', number: 7 }], [die(6, 4)]))?.notation, '1d6@4');
    assert.equal(present(roll([die(6, 4)], [die(6, 4)]))?.notation, '1d6+1d6@4,4', 'equal faces are independent dice');
    assert.equal(present(roll([pool(roll([die(6, 2)]), roll([die(6, 5)]))]))?.notation,
        '1d6+1d6@2,5', 'discarded pool branches still display their recorded dice');
    assert.equal(present(roll([fn(roll([{ class: 'NumericTerm', number: 5 }])), die(6, 2)]))?.notation, '1d6@2');
    assert.equal(present(roll([fn(roll([{ class: 'NumericTerm', number: 5 }]))])), null, 'no dice invented from function results');

    const child = roll([die(6, 4)]);
    for (const bad of [
        { class: 'Unknown', rolls: [child] }, { ...die(6, 2), class: 'FateDie' },
        { ...die(6, 2), class: 'Coin' }, { ...die(6, 2), class: 'CustomDie' },
        { ...parenthetical(child), roll: undefined }, { ...parenthetical(child), roll: JSON.stringify(child) },
        { ...parenthetical(child), evaluated: false }, { ...parenthetical(child), evaluated: undefined },
        { ...pool(child), rolls: [] }, { ...pool(child), terms: [] }, { ...pool(child), rolls: [null] },
        { ...fn(child), rolls: [{ ...child, evaluated: false }] },
        { ...fn(child), rolls: [{ ...child, terms: [{ class: 'StringTerm', term: '1d6' }] }] },
        { ...pool(child), rolls: [{ ...child, dice: 'invalid' }] },
        { ...die(6, 2), evaluated: false }, { ...die(6, 2), results: [{ result: Infinity }] },
    ]) assert.equal(present(roll([die(20, 17), bad])), null, 'unsupported child rejects the whole throw');
    assert.equal(present(roll([die(6, 3)], [pool(child)])), null, 'retained dice are DiceTerms, not arbitrary containers');
    assert.equal(present({ ...child, terms: Array(101).fill({ class: 'NumericTerm', number: 0 }) }), null);
    assert.equal(present({ ...child, dice: Array(101).fill(die(6, 1)) }), null);
    assert.equal(toDicePresentation({ ...message, rolls: Array(11).fill(child) }), null);

    let deep = child;
    for (let i = 0; i < 16; i++) deep = roll([parenthetical(deep)]);
    assert.ok(present(deep), '16 child-roll nesting levels are allowed');
    assert.equal(present(roll([parenthetical(deep)])), null, '17 levels are rejected');
    const cycle = roll([]);
    cycle.terms.push(parenthetical(cycle));
    assert.equal(present(cycle), null, 'known-field reference cycles are rejected');

    // Count each Roll, Term and die-result record; root depth is zero.
    const numeric = { class: 'NumericTerm', number: 0 };
    const wide = Array.from({ length: 9 }, () => roll(Array(100).fill(numeric)));
    wide.push(roll([...Array(88).fill(numeric), die(6, 1)]));
    assert.ok(toDicePresentation({ ...message, rolls: wide }), 'exactly 1000 nodes');
    wide[9].terms.unshift(numeric);
    assert.equal(toDicePresentation({ ...message, rolls: wide }), null, '1001 nodes');
    const percentile = roll([pool(roll([die(100, ...Array(12).fill(42))]))]);
    assert.equal(present(percentile)?.notation.split('@')[1].split(',').length, 24);
    percentile.terms.push(die(6, 1));
    assert.equal(present(percentile), null, 'physical dice limit spans nested and flat terms');

    const blind = { ...message, blind: true, whisper: ['gm'] };
    assert.ok(toDicePresentation(blind));
    for (const visibility of [undefined, false, 'true', 1, null]) {
        assert.equal(toDicePresentation({ ...blind, isContentVisible: visibility }), null, 'blind requires explicit DTO authorization');
    }
    assert.equal(toDicePresentation({ ...blind, blind: 'true' }), null);
    const ownBlind = toDicePresentation({ ...blind, author: 'gm' })!;
    assert.ok(ownBlind, 'sole recipient GM author is not a Self roll');
    assert.equal(ownBlind.privateRoll, true);
    assert.equal(toDicePresentation({ ...blind, author: 'gm', blind: false }), null, 'Self remains chat-only');
    assert.equal(toDicePresentation({ ...blind, whisper: [] })?.privateRoll, true);
    const sound = { enabled: true, volume: 75 };
    assert.equal(diceSoundForRoll(sound, defaultDiceBehavior, ownBlind).enabled, false);
    assert.equal(diceSoundForRoll(sound, { ...defaultDiceBehavior, mutePrivateRolls: false }, ownBlind), sound);
    assert.equal(allowsDicePresentation(ownBlind, { ...defaultDiceBehavior, ownRollsOnly: true }, 'gm'), true);
    assert.equal(allowsDicePresentation(ownBlind, { ...defaultDiceBehavior, ownRollsOnly: true }, 'other'), false);

    const inbox = new LiveDiceInbox();
    assert.deepEqual(inbox.consume([blind], 0), [], 'blind history is silent');
    inbox.created(blind._id, 1);
    assert.equal(inbox.consume([blind], 2).length, 1);
    inbox.created(blind._id, 3);
    assert.deepEqual(inbox.consume([blind], 4), [], 'no duplicate blind animation');
    inbox.reset();
    assert.deepEqual(inbox.consume([blind], 5), [], 'reconnect does not replay');
    inbox.created(blind._id, 6);
    assert.deepEqual(inbox.consume([{ ...blind, isContentVisible: false }], 7), []);
    inbox.created(blind._id, 8);
    assert.deepEqual(inbox.consume([blind], 9), [], 'later authorization does not replay a consumed hint');
    console.log('  - Nested dice and authorized blind presentation: all checks passed');
}
