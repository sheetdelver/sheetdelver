import type { AppConfig } from '@shared/interfaces';
import type { ChatClientLike, ChatSendBody, ChatMessageDocument } from '@server/shared/types/documents';
import type { ChatLogPayload, ChatSendSuccessPayload, ChatErrorPayload, ChatMessageDto } from '@shared/contracts/chat';
import { chatMessageStore, hasChatRolls } from '@server/core/documents/primary/chat-messages/ChatMessageStore';
import {
    DOCUMENT_VISIBILITY,
    FoundryUserRole,
    createDocumentAccessSubject,
    isAssistantGM,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import {
    createTextChatMessageData,
    isRecord,
    normalizeChatMessageCreateData,
    normalizeSpeaker,
} from '@server/core/documents/primary/chat-messages/chatMessagePayload';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { PrimaryDocumentCacheNotReadyError } from '@server/core/documents/primary/errors';

interface ChatServiceDeps {
    config: AppConfig;
}

function projectChatMessage(message: ChatMessageDocument, subject: DocumentAccessSubject | null): ChatMessageDto {
    const rolls = (Array.isArray(message.rolls) ? message.rolls : []).map((roll: unknown) => {
        if (typeof roll !== 'string') return roll;
        try {
            return JSON.parse(roll);
        } catch {
            return roll;
        }
    });
    const roll = rolls[0] as { total?: number; formula?: string } | undefined;
    // Foundry v13+ stores roll semantics in `rolls`; retain the old numeric
    // check only for cache rows created before the canonical payload migration.
    const isRoll = hasChatRolls(message);
    const isBlind = message.blind === true;
    // GM-like authors can see their own blind results. Non-author viewers
    // still need to be listed recipients of private rolls.
    const isAssistantGm = subject ? isAssistantGM(subject) : true;
    const subjectUserId = subject?.userId ?? null;
    const isAuthor = typeof message.author === 'string' && message.author === subjectUserId;
    const whisper = Array.isArray(message.whisper) ? message.whisper : [];
    // Match Foundry's separate message/content visibility. A GM who is not a
    // recipient does not gain the contents of another user's self roll.
    const shouldMask = isRoll
        ? (isAuthor ? isBlind && !isAssistantGm
            : whisper.length > 0 ? !whisper.includes(subjectUserId) : isBlind)
        : isBlind && !isAssistantGm && !isAuthor;
    const author = typeof message.author === 'string'
        ? userStore.get(message.author)
        : null;

    if (isRoll && shouldMask) {
        // Allowlist only: content, flavor, flags, speaker, formulas and results
        // can all contain secrets. Never spread a hidden source document.
        return {
            _id: message._id,
            author: typeof message.author === 'string' ? message.author : undefined,
            user: author?.name || 'Unknown',
            timestamp: typeof message.timestamp === 'number' ? message.timestamp : 0,
            isRoll: true,
            isContentVisible: false,
            content: '',
            rolls: [],
        };
    }

    return {
        ...message,
        isContentVisible: true,
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
     * log per ADR-0011). Non-roll message access uses Store ownership; rolls
     * are projected here into authorized content or allowlisted placeholders.
     * Display cap from
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
            ? userStore.getRole(userId)
            : FoundryUserRole.GAMEMASTER;
        const subject = createDocumentAccessSubject(userId ?? 'system', role);

        if (!chatMessageStore.isReady()) {
            throw new PrimaryDocumentCacheNotReadyError('ChatMessage');
        }

        // The service can read the mirror, but must project before returning.
        // Private rolls have public placeholders; ordinary whispers stay omitted.
        const visible = chatMessageStore.list().filter(message => hasChatRolls(message)
            || !subject || (typeof message._id === 'string' && chatMessageStore.canReadDocument(
                message._id, subject, DOCUMENT_VISIBILITY.LIST_VISIBLE,
            )));
        const sorted = [...visible].sort((a, b) => ((a.timestamp as number) || 0) - ((b.timestamp as number) || 0));
        const rawMessages = sorted.slice(Math.max(sorted.length - limit, 0));
        const messages = rawMessages.map(message => projectChatMessage(message, subject));
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
            const chatData = normalizeChatMessageCreateData(isRecord(synthetic)
                ? { ...synthetic }
                : { content: String(synthetic), style: 0 });
            delete chatData._synthetic;
            if (!chatData.author && client.userId) chatData.author = client.userId;
            if (!chatData.author) throw new Error('Cannot send message: Author ID missing');
            const response = await client.createChatMessage(chatData);
            // Do not leak a blind result back to its author through the write response.
            if (chatData.blind === true && !isAssistantGM(createDocumentAccessSubject(
                client.userId ?? 'system',
                client.userId ? userStore.getRole(client.userId) : FoundryUserRole.GAMEMASTER,
            )!)) return { success: true, type: 'roll' };
            return { success: true, type: 'roll', result: isRecord(response) ? response.result ?? response : response };
        }

        const chatData = await createTextChatMessageData({
            content: message,
            author: client.userId,
            rollMode: body.rollMode,
            speaker: body.speaker,
            getGmUserIds: () => userStore.getGmUserIds(),
        });

        await client.createChatMessage(chatData);
        return { success: true, type: 'chat' };
    };

    return {
        getChatLog,
        sendChatMessage
    };
}
