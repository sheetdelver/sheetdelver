import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMessageCard } from '../../../client/ui/components/Chat/ChatMessageCard';
import { formatChatContent, messageAuthor, messageRolls, orderedMessages } from '../../../client/ui/components/Chat/chatMessage';
import { isPostedChatMessage } from '../../../shared/utils/postedChatMessage';

export function run() {
    const secret = { _id: 'hidden', user: 'Player', isContentVisible: false, speaker: { alias: 'SECRET' },
        content: '<b>SECRET</b>', flavor: 'SECRET', rolls: [{ total: 99, formula: 'SECRET' }], rollTotal: 99 };
    assert.equal(messageAuthor(secret), 'Player');
    assert.deepEqual(messageRolls(secret), []);
    const html = renderToStaticMarkup(React.createElement(ChatMessageCard, { message: secret }));
    assert.ok(html.includes('???'));
    assert.ok(!html.includes('SECRET'));
    assert.ok(!html.includes('99'));
    const message = { _id: 'public', user: 'Player', speaker: { alias: 'Fighter' }, content: '<b>Attack</b>',
        rolls: [{ total: 0, formula: '1d6-1' }, JSON.stringify({ total: 12, formula: '2d6' }), 'bad', { total: Infinity }] };
    assert.equal(messageAuthor(message), 'Fighter');
    assert.deepEqual(messageRolls(message), [{ formula: '1d6-1', total: 0 }, { formula: '2d6', total: 12 }]);
    assert.deepEqual(messageRolls({ rollTotal: 0, rollFormula: 'legacy' }), [{ formula: 'legacy', total: 0 }]);
    const rendered = renderToStaticMarkup(React.createElement(ChatMessageCard, { message }));
    assert.ok(rendered.includes('Fighter') && rendered.includes('1d6-1') && rendered.includes('2d6'));
    const formatted = String(formatChatContent('[[/roll 1d20]] [[/r 2d6]] <img src="icons/test.webp" onerror="bad()">', 'https://foundry.example'));
    assert.ok(formatted.includes('data-formula="1d20"'));
    assert.ok(!formatted.includes('data-formula="oll 1d20"'));
    assert.ok(formatted.includes('https://foundry.example/icons/test.webp'));
    assert.ok(!formatted.includes('onerror'));
    assert.deepEqual(orderedMessages([{ _id: 'b', timestamp: 2 }, { _id: 'a', timestamp: 1 }]).map(m => m._id), ['a', 'b']);
    assert.equal(isPostedChatMessage({ _id: 'chat', author: 'player', rolls: [] }), true);
    for (const value of [null, 3, { total: 20 }, { _id: 'item' }, { _id: 'chat', author: 'p', rolls: [], _synthetic: true }]) {
        assert.equal(isPostedChatMessage(value), false);
    }
}
