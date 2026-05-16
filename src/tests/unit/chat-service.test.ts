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
        username: 'Player',
        on: () => undefined,
        off: () => undefined,
        getChatLog: async () => [],
        createChatMessage: async () => ({ result: [] }),
        dispatchDocument: async () => ({ result: [] }),
        roll: async () => ({ author: 'p-author', content: '7', type: 5, rolls: ['{"total":7,"formula":"1d20"}'] }),
        ...overrides,
    };
}

export async function run() {
    await runStoreBackedReadsProjectChatDto();
    await runNormalChatWritesThroughCreateChatMessage();
    await runRollChatWritesThroughCreateChatMessage();
    console.log('  - ChatService: all checks passed');
}

async function withMockUsers(callback: () => Promise<void>) {
    await userStore.seed(async () => [
        { _id: 'p-author', name: 'Alice', role: FoundryUserRole.PLAYER },
        { _id: 'gm-1', name: 'GM', role: FoundryUserRole.GAMEMASTER },
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
                type: 5,
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
        assert.equal(createdMessages[0].type, 1);
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
                    type: 5,
                    rolls: ['{"total":7,"formula":"1d20"}'],
                };
            },
        }), { message: '/roll 1d20' });

        assert.equal('success' in payload && payload.success, true);
        assert.equal(createdMessages.length, 1);
        assert.equal(createdMessages[0]._synthetic, undefined);
        assert.equal(createdMessages[0].type, 5);
        assert.equal((rollOptions[0] as any).displayChat, false);
        assert.equal(rawDispatchCalls, 0);
    });
}
