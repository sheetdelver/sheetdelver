import { run as runDiceRollPaths } from './dice-roll-paths.test';
import { strict as assert } from 'node:assert';
import { createChatService } from '@server/services/chat/ChatService';
import { chatMessageStore } from '@server/core/documents/primary/chat-messages/ChatMessageStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { FoundryUserRole } from '@server/core/documents/primary/base/ownership';
import type { ChatClientLike } from '@server/shared/types/documents';
import { createDocumentStore } from '@server/shared/utils/moduleDocumentServices';

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
    await runTextWhisperMatrix();
    await runBlindWriteResponse();
    await runNormalChatWritesThroughCreateChatMessage();
    await runRollChatWritesThroughCreateChatMessage();
    await runOwnedSheetSpeaker();
    console.log('  - ChatService: all checks passed');
}

async function runTextWhisperMatrix() {
    await withMockUsers(async () => {
        const source = { _id: 'text', author: 'p-author', whisper: ['other'], content: 'PRIVATE TEXT', rolls: [] };
        await chatMessageStore.seed(async () => [source]);
        const service = createChatService(config);
        for (const userId of ['p-author', 'other', 'gm-1', 'assistant']) {
            const client = createMockClient({ userId });
            const documents = createDocumentStore(client as any, async () => {});
            const allowed = ['p-author', 'other'].includes(userId);
            assert.equal((await service.getChatLog(client, 100)).messages.length, allowed ? 1 : 0);
            assert.equal(!!await documents.get('ChatMessage', 'text'), allowed);
            assert.equal(!!await documents.fetchByUuid('ChatMessage.text'), allowed);
        }
        chatMessageStore.applyModifyDocument('ChatMessage', 'update', [{ _id: 'text', whisper: ['gm-1', 'assistant'] }]);
        for (const userId of ['gm-1', 'assistant']) {
            assert.equal((await service.getChatLog(createMockClient({ userId }), 100)).messages[0].content, 'PRIVATE TEXT',
                'GM/Assistant recipients still receive messages addressed to them');
        }
        assert.deepEqual(source.whisper, ['other']);
    });
}

async function runOwnedSheetSpeaker() {
    await withMockUsers(async () => {
        await actorStore.seed(async () => [
            { _id: 'owned-actor', name: 'Zali', ownership: { default: 0, 'p-author': 3 } as Record<string, number> },
            { _id: 'unowned-actor', name: 'Secret NPC', ownership: { default: 0 } as Record<string, number> },
        ]);
        try {
            const created: Array<Record<string, unknown>> = [];
            const service = createChatService(config);
            const client = createMockClient({ createChatMessage: async data => { created.push(data); return {}; } });
            const sent = await service.sendChatMessage(client, {
                message: 'Hello', speaker: 'Forged alias', speakerActorId: 'owned-actor',
            });
            assert.equal('success' in sent && sent.success, true);
            assert.equal(created[0].author, 'p-author');
            assert.deepEqual(created[0].speaker, { actor: 'owned-actor', alias: 'Zali' });

            const denied = await service.sendChatMessage(client, {
                message: 'Hello', speakerActorId: 'unowned-actor',
            });
            assert.deepEqual(denied, { error: 'Actor speaker is not owned by this user', status: 403 });
            const malformed = await service.sendChatMessage(client, {
                message: 'Hello', speakerActorId: { _id: 'owned-actor' } as unknown as string,
            });
            assert.deepEqual(malformed, { error: 'Invalid Actor speaker', status: 400 });
            assert.equal(created.length, 1);
        } finally {
            actorStore.clear('chat-speaker-test');
        }
    });
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
            if (userId !== 'p-author') {
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
