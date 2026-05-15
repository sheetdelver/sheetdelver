import type { AppConfig } from '@shared/interfaces';
import type { ChatClientLike, ChatSendBody } from '@server/shared/types/documents';
import type { ChatLogPayload, ChatSendSuccessPayload, ChatErrorPayload } from '@shared/contracts/chat';
import { chatMessageStore } from '@server/core/documents/primary/chat-messages/ChatMessageStore';
import { systemService } from '@core/system/SystemService';
import {
    DOCUMENT_VISIBILITY,
    FoundryUserRole,
    createDocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';

interface ChatServiceDeps {
    config: AppConfig;
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
        // Most-recent N. Foundry chat log is typically already in timestamp order,
        // but slice from the tail to be safe.
        const messages = visible.slice(Math.max(visible.length - limit, 0));
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
            const result = await client.roll(cleanFormula, undefined, {
                rollMode,
                speaker: body.speaker
            });
            return { success: true, type: 'roll', result };
        }

        await client.sendMessage(message, {
            rollMode: body.rollMode,
            speaker: body.speaker
        });
        return { success: true, type: 'chat' };
    };

    return {
        getChatLog,
        sendChatMessage
    };
}
