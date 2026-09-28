import assert from 'node:assert/strict';
import { DicePresentationQueue } from '../../../client/ui/components/Dice/presentationQueue';
import { defaultDiceBehavior as defaults } from '../../../client/ui/components/Dice/behavior';
import type { ChatMessageDto } from '../../../shared/contracts/chat';

const message = (id: string, changes: Partial<ChatMessageDto> = {}): ChatMessageDto => ({
    _id: id, author: 'player', timestamp: 1, isContentVisible: true,
    rolls: [{ evaluated: true, terms: [{ class: 'Die', faces: 6, results: [{ result: 4 }] }] }],
    ...changes,
});
export function run() {
    const queue = new DicePresentationQueue();
    queue.configure(true, defaults, 'player');
    queue.read([message('history')], 0);
    queue.created('history', 1); queue.read([message('history')], 2);
    assert.equal(queue.snapshot().length, 0, 'late hint cannot animate/re-hide an already visible read');
    queue.created('a', 3); queue.read([message('history'), message('a')], 4);
    const a = queue.snapshot()[0];
    assert.equal(a.held, true);
    queue.settled(a.sequence);
    assert.equal(queue.snapshot()[0].held, false, 'settlement releases chat before linger/disposal');
    queue.created('a', 5); queue.read([message('a')], 6);
    assert.equal(queue.snapshot().length, 1);
    queue.done(a.sequence);
    assert.equal(queue.snapshot().length, 0);
    for (const id of ['b', 'c', 'd', 'fourth']) queue.created(id, 7);
    queue.read(['b', 'c', 'd', 'fourth'].map(id => message(id)), 8);
    assert.deepEqual(queue.snapshot().map(roll => roll.id), ['b', 'c', 'd', 'fourth'],
        'message count alone cannot suppress a shared-scene throw');
    const [b, c] = queue.snapshot();
    queue.settled(c.sequence);
    assert.equal(queue.snapshot().find(roll => roll.id === 'c')?.held, false,
        'each concurrent throw releases its own card on settlement');
    assert.equal(queue.snapshot().find(roll => roll.id === 'b')?.held, true,
        'another unsettled throw stays held');
    queue.done(c.sequence);
    assert.deepEqual(queue.snapshot().map(roll => roll.id), ['b', 'd', 'fourth'],
        'a finished throw does not block or remove its peers');
    queue.configure(true, { ...defaults, showResultsImmediately: true }, 'player');
    assert.ok(queue.snapshot().every(roll => !roll.held));
    queue.configure(true, defaults, 'player');
    assert.ok(queue.snapshot().every(roll => !roll.held), 'turning delay back on never re-hides results');
    queue.invalidated('b');
    queue.read([message('c', { isContentVisible: false }), message('d')], 9);
    assert.deepEqual(queue.snapshot().map(roll => roll.id), ['d'], 'fresh authorization must cancel old animation');
    const old = queue.snapshot()[0].sequence;
    queue.reset(); queue.created('d', 10); queue.read([message('d')], 11);
    queue.done(old); queue.settled(old);
    assert.equal(queue.snapshot()[0].held, true, 'stale callbacks cannot affect a new session');
    queue.configure(false, defaults, 'player');
    assert.equal(queue.snapshot().length, 0, 'disabled/hidden/reduced-motion/failure release all held results');
    queue.created('disabled', 12); queue.read([message('disabled')], 13);
    queue.configure(true, defaults, 'player'); queue.read([message('disabled')], 14);
    assert.equal(queue.snapshot().length, 0);
    queue.reset();
    const cases = [
        message('self', { whisper: ['player'] }),
        message('hidden', { isContentVisible: false }),
        message('blind-hidden', { blind: true, isContentVisible: undefined }),
        message('text', { rolls: [] }), message('unsupported', { rolls: [{ evaluated: false }] }),
        message('blind-visible', { blind: true, whisper: ['player'] }),
    ];
    cases.forEach(m => queue.created(m._id!, 20)); queue.read(cases, 21);
    assert.deepEqual(queue.snapshot().map(roll => roll.id), ['blind-visible']);
    queue.configure(true, { ...defaults, ownRollsOnly: true }, 'other');
    assert.equal(queue.snapshot().length, 0);
    queue.configure(true, defaults, 'player'); queue.read(cases, 22);
    assert.equal(queue.snapshot().length, 0, 'relaxing filters never replays consumed rolls');
    queue.created('invalidated-before-read', 23); queue.invalidated('invalidated-before-read');
    queue.read([message('invalidated-before-read')], 24);
    assert.equal(queue.snapshot().length, 0);
    queue.created('expired', 25); queue.read([message('expired')], 10026);
    assert.equal(queue.snapshot().length, 0, 'missing/expired hints never hold chat');
    queue.created('deleted', 10027); queue.read([message('deleted')], 10028);
    queue.read([], 10029);
    assert.equal(queue.snapshot().length, 0, 'absent current DTO releases resources');

    queue.reset();
    const manyDice = (id: string, count: number) => message(id, { rolls: [{ evaluated: true, terms: [{
        class: 'Die', faces: 6, results: Array.from({ length: count }, () => ({ result: 4 })),
    }] }] });
    for (const id of ['first24', 'second24', 'third24', 'fourth24', 'excess']) queue.created(id, 10100);
    queue.read(['first24', 'second24', 'third24', 'fourth24', 'excess']
        .map(id => id === 'excess' ? message(id) : manyDice(id, 24)), 10101);
    assert.deepEqual(queue.snapshot().map(roll => roll.id), ['first24', 'second24', 'third24', 'fourth24'],
        'shared-scene admission keeps the total visible mesh count at 96');
    assert.equal(queue.snapshot().reduce((total, roll) => total + (roll.physicalDiceCount ?? 0), 0), 96);
    queue.done(queue.snapshot()[0].sequence);
    queue.read(['first24', 'second24', 'third24', 'fourth24', 'excess']
        .map(id => id === 'excess' ? message(id) : manyDice(id, 24)), 10102);
    assert.deepEqual(queue.snapshot().map(roll => roll.id), ['second24', 'third24', 'fourth24'],
        'overflow is chat-only, never replayed after a slot opens');
}
