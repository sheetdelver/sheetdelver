import { strict as assert } from 'node:assert';
import { createChatService } from '@server/services/chat/ChatService';
import { chatMessageStore } from '@server/core/documents/primary/chat-messages/ChatMessageStore';
import { systemService } from '@core/system/SystemService';
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
        dispatchDocument: async () => ({ result: [] }),
        roll: async () => ({ author: 'p-author', content: '7', type: 5, rolls: ['{"total":7,"formula":"1d20"}'] }),
        sendMessage: async () => {
            throw new Error('sendMessage should not be used by ChatService writes');
        },
        ...overrides,
    };
}

export async function run() {
    await runStoreBackedReadsProjectChatDto();
    await runNormalChatWritesThroughDispatchDocument();
    await runRollChatWritesThroughDispatchDocument();
    console.log('  - ChatService: all checks passed');
}

async function withMockSystemClient(callback: () => Promise<void>) {
    const originalGetSystemClient = (systemService as any).getSystemClient;
    (systemService as any).getSystemClient = () => ({
        getUser: (userId: string) => userId === 'p-author' ? { _id: 'p-author', name: 'Alice', role: 1 } : null,
        getUsers: async () => [{ _id: 'gm-1', role: 4 }],
    });

    try {
        await callback();
    } finally {
        (systemService as any).getSystemClient = originalGetSystemClient;
        chatMessageStore.clear('chat-service-test');
    }
}

async function runStoreBackedReadsProjectChatDto() {
    await withMockSystemClient(async () => {
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

async function runNormalChatWritesThroughDispatchDocument() {
    await withMockSystemClient(async () => {
        const dispatches: Array<{ type: string; action: string; operation?: unknown }> = [];
        let sendMessageCalls = 0;
        const service = createChatService(config);
        const payload = await service.sendChatMessage(createMockClient({
            dispatchDocument: async (type, action, operation) => {
                dispatches.push({ type, action, operation });
                return { result: [{ _id: 'chat-1' }] };
            },
            sendMessage: async () => {
                sendMessageCalls += 1;
                return {};
            },
        }), { message: 'Hello' });

        assert.equal('success' in payload && payload.success, true);
        assert.equal(dispatches.length, 1);
        assert.equal(dispatches[0].type, 'ChatMessage');
        assert.equal(dispatches[0].action, 'create');
        assert.equal(sendMessageCalls, 0);
    });
}

async function runRollChatWritesThroughDispatchDocument() {
    await withMockSystemClient(async () => {
        const dispatches: Array<{ type: string; action: string; operation?: any }> = [];
        const rollOptions: unknown[] = [];
        const service = createChatService(config);
        const payload = await service.sendChatMessage(createMockClient({
            dispatchDocument: async (type, action, operation) => {
                dispatches.push({ type, action, operation });
                return { result: [{ _id: 'roll-1' }] };
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
        assert.equal(dispatches.length, 1);
        assert.equal(dispatches[0].type, 'ChatMessage');
        assert.equal(dispatches[0].operation.data[0]._synthetic, undefined);
        assert.equal((rollOptions[0] as any).displayChat, false);
    });
}
