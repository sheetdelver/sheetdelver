import assert from 'node:assert/strict';
import { LiveChatInbox } from '../../../client/ui/context/liveChatInbox';
import { defaultChatToastSettings, normalizeChatToastSettings } from '../../../client/ui/context/chatToast';

export function run() {
    for (const value of [null, undefined, 'bad', {}, { durationMs: NaN }, { durationMs: Infinity }]) {
        assert.deepEqual(normalizeChatToastSettings(value), defaultChatToastSettings);
    }
    assert.deepEqual(normalizeChatToastSettings({ enabled: false, durationMs: 50 }), { enabled: false, durationMs: 1000 });
    assert.equal(normalizeChatToastSettings({ durationMs: 20000 }).durationMs, 15000);
    assert.equal(normalizeChatToastSettings({ durationMs: 2600 }).durationMs, 2500);

    const inbox = new LiveChatInbox<{ _id?: string; id?: string }>();
    const a = { _id: 'a' }, b = { id: 'b' };
    assert.deepEqual(inbox.consume([a, b], 0), [], 'history alone never produces toasts');
    inbox.created('a', 0);
    assert.deepEqual(inbox.consume([], 1), [], 'an event never exposes content without an authorized read');
    inbox.created('b', 2);
    assert.deepEqual(inbox.consume([a, b], 3), [a, b]);
    inbox.created('a', 4);
    assert.deepEqual(inbox.consume([a], 5), [], 'duplicate create hints are ignored');
    inbox.reset();
    inbox.created('a', 0);
    inbox.invalidated('a');
    assert.deepEqual(inbox.consume([a], 1), [], 'edits/deletes cancel pending notifications');
    inbox.created('b', 0);
    assert.deepEqual(inbox.consume([b], 10001), [], 'late reads do not replay old notices');
    inbox.created('a', 11000);
    inbox.reset();
    assert.deepEqual(inbox.consume([a], 11001), [], 'logout/disconnect clears pending notices');
}
