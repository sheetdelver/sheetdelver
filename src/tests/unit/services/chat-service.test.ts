import { run as runDiceRollPaths } from './dice-roll-paths.test';
import { strict as assert } from 'node:assert';
import { createChatService } from '@server/services/chat/ChatService';
import { chatMessageStore } from '@server/core/documents/primary/chat-messages/ChatMessageStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { FoundryUserRole } from '@server/core/documents/primary/base/ownership';
import type { ChatClientLike } from '@server/shared/types/documents';

const config = {
    app: {
        chatHistory: 100,
    },
} as any;

function createMockClient(overrides: Partial<ChatClientLike> = {}): ChatClientLike {
    return {
        userId: 'p-author',
        on: () => undefined,
        off: () => undefined,
        createChatMessage: async () => ({ result: [] }),
        dispatchDocument: async () => ({ result: [] }),
        roll: async () => ({ author: 'p-author', content: '7', style: 0, rolls: ['{"total":7,"formula":"1d20"}'] }),
        ...overrides,
    };
}

export async function run() {
    await runDiceRollPaths();
    await runStoreBackedReadsProjectChatDto();
    await runPrivateRollProjection();
    await runBlindWriteResponse();
    await runNormalChatWritesThroughCreateChatMessage();
    await runRollChatWritesThroughCreateChatMessage();
    console.log('  - ChatService: all checks passed');
}

async function withMockUsers(callback: () => Promise<void>) {
    await userStore.seed(async () => [
        { _id: 'p-author', name: 'Alice', role: FoundryUserRole.PLAYER },
        { _id: 'gm-1', name: 'GM', role: FoundryUserRole.GAMEMASTER },
        { _id: 'other', name: 'Other', role: FoundryUserRole.PLAYER },
        { _id: 'assistant', name: 'Assistant', role: FoundryUserRole.ASSISTANT },
    ]);

    try {
        await callback();
    } finally {
        chatMessageStore.clear('chat-service-test');
        userStore.clear('chat-service-test');
    }
}

async function runStoreBackedReadsProjectChatDto() {
    await withMockUsers(async () => {
        await chatMessageStore.seed(async () => [
            {
                _id: 'roll-message',
                author: 'p-author',
                whisper: [],
                blind: false,
                content: '7',
                flavor: 'Check',
                type: 'base',
                style: 0,
                rolls: ['{"total":7,"formula":"1d20"}'],
                timestamp: 100,
            },
        ]);

        const service = createChatService(config);
        const payload = await service.getChatLog(createMockClient(), 100);

        assert.equal(payload.messages.length, 1);
        assert.equal(payload.messages[0].user, 'Alice');
        assert.equal(payload.messages[0].isRoll, true);
        assert.equal(payload.messages[0].rollTotal, 7);
        assert.equal(payload.messages[0].rollFormula, '1d20');
    });
}

async function runNormalChatWritesThroughCreateChatMessage() {
    await withMockUsers(async () => {
        const createdMessages: Array<Record<string, unknown>> = [];
        let rawDispatchCalls = 0;
        const service = createChatService(config);
        const payload = await service.sendChatMessage(createMockClient({
            createChatMessage: async (data) => {
                createdMessages.push(data);
                return { result: [{ _id: 'chat-1' }] };
            },
            dispatchDocument: async () => {
                rawDispatchCalls += 1;
                return { result: [] };
            },
        }), { message: 'Hello', speaker: 'Narrator' });

        assert.equal('success' in payload && payload.success, true);
        assert.equal(createdMessages.length, 1);
        assert.equal(createdMessages[0].content, 'Hello');
        assert.equal(createdMessages[0].author, 'p-author');
        assert.equal(createdMessages[0].style, 1);
        assert.equal(createdMessages[0].type, undefined);
        assert.deepEqual(createdMessages[0].speaker, { alias: 'Narrator' });
        assert.equal(rawDispatchCalls, 0);
    });
}

async function runRollChatWritesThroughCreateChatMessage() {
    await withMockUsers(async () => {
        const createdMessages: Array<Record<string, unknown>> = [];
        let rawDispatchCalls = 0;
        const rollOptions: unknown[] = [];
        const service = createChatService(config);
        const payload = await service.sendChatMessage(createMockClient({
            createChatMessage: async (data) => {
                createdMessages.push(data);
                return { result: [{ _id: 'roll-1' }] };
            },
            dispatchDocument: async () => {
                rawDispatchCalls += 1;
                return { result: [] };
            },
            roll: async (_formula, _label, options) => {
                rollOptions.push(options);
                return {
                    _synthetic: true,
                    author: 'p-author',
                    content: '7',
                    // Exercise normalization of the legacy shape returned by
                    // older module roll implementations.
                    type: 5,
                    rolls: ['{"total":7,"formula":"1d20"}'],
                };
            },
        }), { message: '/roll 1d20' });

        assert.equal('success' in payload && payload.success, true);
        assert.equal(createdMessages.length, 1);
        assert.equal(createdMessages[0]._synthetic, undefined);
        assert.equal(createdMessages[0].style, 0);
        assert.equal(createdMessages[0].type, undefined);
        assert.equal((rollOptions[0] as any).displayChat, false);
        assert.equal(rawDispatchCalls, 0);
    });
}

async function runPrivateRollProjection() {
    await withMockUsers(async () => {
        const source = {
            author: 'p-author', timestamp: 100, content: 'SECRET result 17',
            flavor: 'SECRET flavor', speaker: { alias: 'SECRET speaker' },
            flags: { private: 'SECRET flags' }, sound: 'SECRET.mp3',
            rolls: [JSON.stringify({ total: 17, formula: 'SECRET formula' })],
        };
        const docs = [
            { ...source, _id: 'public', whisper: [], blind: false },
            { ...source, _id: 'self', whisper: ['p-author'], blind: false },
            { ...source, _id: 'gm', whisper: ['gm-1', 'assistant'], blind: false },
            { ...source, _id: 'blind', whisper: ['gm-1', 'assistant'], blind: true },
            { ...source, _id: 'text-whisper', whisper: ['p-author'], rolls: [] },
        ];
        await chatMessageStore.seed(async () => docs);
        const service = createChatService(config);
        const matrix = {
            'p-author': [true, true, true, false],
            'gm-1': [true, false, true, true],
            assistant: [true, false, true, true],
            other: [true, false, false, false],
        };
        for (const [userId, expected] of Object.entries(matrix)) {
            const payload = await service.getChatLog(createMockClient({ userId }), 100);
            for (const [index, id] of ['public', 'self', 'gm', 'blind'].entries()) {
                const message = payload.messages.find(message => message._id === id)!;
                assert.ok(message, userId + ' gets a roll row for ' + id);
                assert.equal(message.isContentVisible, expected[index], userId + ': ' + id);
                if (expected[index]) {
                    assert.equal(message.rollTotal, 17);
                } else {
                    assert.deepEqual(message, {
                        _id: id, author: 'p-author', user: 'Alice', timestamp: 100,
                        isRoll: true, isContentVisible: false, content: '', rolls: [],
                    });
                    assert.ok(!JSON.stringify(message).includes('SECRET'));
                }
            }
            if (userId === 'other' || userId === 'assistant') {
                assert.ok(!payload.messages.some(message => message._id === 'text-whisper'),
                    'ordinary private messages do not get public placeholders');
            }
        }
        assert.equal(docs[1].content, 'SECRET result 17', 'projection does not mutate source');
    });
}

async function runBlindWriteResponse() {
    await withMockUsers(async () => {
        const service = createChatService(config);
        const payload = await service.sendChatMessage(createMockClient({
            roll: async () => ({
                author: 'p-author', blind: true, whisper: ['gm-1'],
                rolls: ['{"total":17}'], content: 'SECRET result 17',
            }),
            createChatMessage: async data => ({ result: [{ _id: 'blind-write', ...data }] }),
        }), { message: '/br 1d20' });
        assert.deepEqual(payload, { success: true, type: 'roll' },
            'write acknowledgements must not leak blind results to the author');
    });
}
