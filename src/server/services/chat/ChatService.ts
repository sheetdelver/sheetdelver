import type { AppConfig } from '@shared/interfaces';
import type { ChatClientLike, ChatSendBody, RawChatMessage } from '@server/shared/types/documents';
import type { ChatLogPayload, ChatSendSuccessPayload, ChatErrorPayload, ChatMessageDto } from '@shared/contracts/chat';
import { chatMessageStore } from '@server/core/documents/primary/chat-messages/ChatMessageStore';
import { systemService } from '@core/system/SystemService';
import {
    DOCUMENT_VISIBILITY,
    FoundryUserRole,
    createDocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import {
    createTextChatMessageData,
    isRecord,
    normalizeSpeaker,
} from '@server/core/documents/primary/chat-messages/chatMessagePayload';

interface ChatServiceDeps {
    config: AppConfig;
}

function projectChatMessage(message: RawChatMessage, subjectUserId: string | null, subjectRole: number): ChatMessageDto {
    const rolls = (Array.isArray(message.rolls) ? message.rolls : []).map((roll: unknown) => {
        if (typeof roll !== 'string') return roll;
        try {
            return JSON.parse(roll);
        } catch {
            return roll;
        }
    });
    const roll = rolls[0] as { total?: number; formula?: string } | undefined;
    const isRoll = message.type === 5;
    const isBlind = message.blind === true;
    const isGmLike = subjectRole >= FoundryUserRole.ASSISTANT;
    const isAuthor = typeof message.author === 'string' && message.author === subjectUserId;
    const shouldMask = isBlind && !isGmLike && !isAuthor;
    const author = typeof message.author === 'string'
        ? systemService.getSystemClient().getUser(message.author)
        : null;

    return {
        ...message,
        user: author?.name || (typeof message.alias === 'string' ? message.alias : undefined) || 'Unknown',
        timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
        isRoll,
        rolls: shouldMask ? [] : rolls,
        rollTotal: shouldMask ? undefined : (roll?.total !== undefined ? roll.total : (isRoll ? Number(message.content) : undefined)),
        rollFormula: shouldMask ? '???' : (roll?.formula || (isRoll && typeof message.flavor === 'string' ? message.flavor : undefined)),
        flavor: typeof message.flavor === 'string' ? message.flavor : undefined,
    };
}

export function createChatService(deps: ChatServiceDeps) {
    /**
     * Chat history read model used by the chat feed endpoint.
     *
     * Phase 1: reads from {@link ChatMessageStore} (full mirror of Foundry's chat
     * log per ADR-0011). Whisper / blind / world-visible filtering happens at
     * the Store via `resolveOwnership` (ADR-0013). Display cap from
     * `config.app.chatHistory` is applied here at the service boundary — the
     * data model itself is uncapped.
     */
    const getChatLog = async (client: ChatClientLike, limitParam: unknown): Promise<ChatLogPayload> => {
        const limit = parseInt(limitParam as string) || deps.config.app.chatHistory || 100;

        // Construct the subject for ownership-aware reads. Service-account / system
        // routes have no userId; treat them as GM-equivalent for chat (chat is
        // mostly world-visible anyway).
        const userId = client.userId;
        const role = userId
            ? (systemService.getSystemClient().getUser(userId)?.role ?? FoundryUserRole.NONE)
            : FoundryUserRole.GAMEMASTER;
        const subject = createDocumentAccessSubject(userId ?? 'system', role);

        // Store may be cold during early bootstrap; fall back to a fresh fetch
        // so existing callers don't see an empty payload during the seed window.
        if (!chatMessageStore.isReady()) {
            const messages = await client.getChatLog(limit);
            return { messages };
        }

        const visible = subject
            ? chatMessageStore.list({ subject, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE })
            : chatMessageStore.list();
        const sorted = [...visible].sort((a, b) => ((a.timestamp as number) || 0) - ((b.timestamp as number) || 0));
        const rawMessages = sorted.slice(Math.max(sorted.length - limit, 0));
        const messages = rawMessages.map(message => projectChatMessage(message, userId ?? null, role));
        return { messages };
    };

    // Chat send orchestration with slash-roll command detection and mode normalization.
    const sendChatMessage = async (
        client: ChatClientLike,
        body: ChatSendBody
    ): Promise<ChatSendSuccessPayload | ChatErrorPayload> => {
        const { message } = body;
        if (!message) return { error: 'Message is empty', status: 400 };

        const ROLL_CMD = /^\/(r|roll|gmr|gmroll|br|blindroll|sr|selfroll)(?=\s|$|\d)/i;
        const match = message.trim().match(ROLL_CMD);

        if (match) {
            const cmd = match[1].toLowerCase();
            let rollMode = body.rollMode;
            if (cmd === 'gmr' || cmd === 'gmroll') rollMode = 'gmroll';
            if (cmd === 'br' || cmd === 'blindroll') rollMode = 'blindroll';
            if (cmd === 'sr' || cmd === 'selfroll') rollMode = 'selfroll';
            if (cmd === 'r' || cmd === 'roll') rollMode = 'publicroll';

            const cleanFormula = message.trim().replace(ROLL_CMD, '').trim();
            const synthetic = await client.roll(cleanFormula, undefined, {
                rollMode,
                speaker: normalizeSpeaker(body.speaker),
                displayChat: false,
            });
            const chatData: Record<string, unknown> = isRecord(synthetic)
                ? { ...synthetic }
                : { content: String(synthetic), type: 5 };
            delete chatData._synthetic;
            if (!chatData.author && client.userId) chatData.author = client.userId;
            if (!chatData.author) throw new Error('Cannot send message: Author ID missing');
            const response = await client.createChatMessage(chatData);
            return { success: true, type: 'roll', result: isRecord(response) ? response.result ?? response : response };
        }

        const chatData = await createTextChatMessageData({
            content: message,
            author: client.userId,
            rollMode: body.rollMode,
            speaker: body.speaker,
            getUsers: () => systemService.getSystemClient().getUsers(),
        });

        await client.createChatMessage(chatData);
        return { success: true, type: 'chat' };
    };

    return {
        getChatLog,
        sendChatMessage
    };
}
