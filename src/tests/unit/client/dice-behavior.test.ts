import assert from 'node:assert/strict';
import { allowsDicePresentation, defaultDiceBehavior, diceSoundForRoll, normalizeDiceBehavior } from '../../../client/ui/components/Dice/behavior';
import { LiveDiceInbox, toDicePresentation } from '../../../client/ui/components/Dice/presentation';

export function run() {
    for (const value of [null, [], 'true', { displayDurationMs: Infinity }, { displayDurationMs: NaN },
        { displayDurationMs: '5000', ownRollsOnly: 'true', lowEffects: 1, mutePrivateRolls: 'false' }]) {
        assert.deepEqual(normalizeDiceBehavior(value), defaultDiceBehavior);
    }
    assert.equal(normalizeDiceBehavior({ displayDurationMs: -100 }).displayDurationMs, 500);
    assert.equal(normalizeDiceBehavior({ displayDurationMs: 20000 }).displayDurationMs, 5000);
    assert.equal(normalizeDiceBehavior({ displayDurationMs: 1860 }).displayDurationMs, 1900);
    const own = { ...defaultDiceBehavior, ownRollsOnly: true };
    const message = {
        _id: 'mine', author: 'user-1', user: 'Display name', whisper: ['user-1', 'gm-1'],
        rolls: [{ evaluated: true, terms: [{ class: 'Die', faces: 6, results: [{ result: 4 }] }] }],
    };
    const roll = toDicePresentation(message)!;
    assert.equal(roll.authorId, 'user-1');
    assert.equal(roll.privateRoll, true);
    assert.equal(roll.notation, '1d6@4');
    assert.equal(allowsDicePresentation(roll, own, 'user-1'), true);
    assert.equal(allowsDicePresentation(roll, own, 'user-2'), false);
    assert.equal(allowsDicePresentation(roll, own, null), false);
    assert.equal(allowsDicePresentation({ ...roll, authorId: undefined }, own, 'Display name'), false);
    assert.equal(allowsDicePresentation(roll, defaultDiceBehavior, 'user-2'), true);
    const noAuthor = toDicePresentation({ ...message, author: undefined })!;
    assert.equal(noAuthor.authorId, undefined, 'display name must never be used as an author ID');
    const sound = { enabled: true, volume: 75 };
    assert.deepEqual(diceSoundForRoll(sound, defaultDiceBehavior, roll), { enabled: false, volume: 75 });
    assert.equal(sound.enabled, true, 'private muting must not overwrite saved preferences');
    assert.equal(diceSoundForRoll(sound, { ...defaultDiceBehavior, mutePrivateRolls: false }, roll), sound);
    const publicRoll = toDicePresentation({ ...message, whisper: [] })!;
    assert.equal(diceSoundForRoll(sound, defaultDiceBehavior, publicRoll), sound);
    assert.equal(toDicePresentation({ ...message, blind: true }), null, 'unmuting must not expose blind dice');
    const inbox = new LiveDiceInbox();
    inbox.created('mine', 0);
    assert.deepEqual(inbox.consume([message], 1).filter(value => allowsDicePresentation(value, own, 'user-2')), []);
    inbox.created('mine', 2);
    assert.deepEqual(inbox.consume([message], 3), [], 'filtered rolls are consumed, not deferred for replay');
}
