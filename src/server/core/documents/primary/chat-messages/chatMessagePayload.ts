import type { ChatSendBody } from '@server/shared/types/documents';

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeSpeaker(speaker: ChatSendBody['speaker'] | unknown): ChatSendBody['speaker'] | undefined {
    if (!speaker) return undefined;
    if (typeof speaker === 'string') return { alias: speaker };
    return isRecord(speaker) ? speaker as ChatSendBody['speaker'] : undefined;
}

/**
 * Convert the pre-v14 numeric `type` compatibility shape into Foundry's
 * canonical ChatMessage `style` field. String `type` values are document
 * subtypes and must remain intact.
 */
export function normalizeChatMessageCreateData(data: Record<string, unknown>): Record<string, unknown> {
    const normalized = { ...data };
    if (typeof normalized.type !== 'number') return normalized;

    if (typeof normalized.style !== 'number') {
        // Foundry v13 mapped removed ROLL/WHISPER values to OTHER; rolls and
        // whisper recipients now carry those semantics independently.
        normalized.style = normalized.type >= 0 && normalized.type <= 3
            ? normalized.type
            : 0;
    }
    delete normalized.type;
    return normalized;
}

export async function resolveRollModeData(
    mode: string | undefined,
    userId: string | null | undefined,
    getGmUserIds: () => Promise<string[]> | string[],
): Promise<Record<string, unknown>> {
    if (!mode || mode === 'publicroll' || mode === 'public') return {};
    if (mode === 'selfroll' || mode === 'self') return { whisper: userId ? [userId] : [] };

    const gmIds = await getGmUserIds();
    const authorId = userId ? [userId] : [];

    if (mode === 'gmroll' || mode === 'gm' || mode === 'private') {
        return { whisper: Array.from(new Set([...gmIds, ...authorId])) };
    }
    if (mode === 'blindroll' || mode === 'blind') return { blind: true, whisper: gmIds };

    return {};
}

export async function createTextChatMessageData(options: {
    content: string;
    author: string | null | undefined;
    rollMode?: string;
    speaker?: ChatSendBody['speaker'] | unknown;
    getGmUserIds: () => Promise<string[]> | string[];
    extra?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
    const { content, author, rollMode, speaker, getGmUserIds, extra } = options;
    if (!author) throw new Error('Cannot send message: Author ID missing');

    const data: Record<string, unknown> = {
        ...(extra || {}),
        content,
        author,
    };
    // Supply the normal OOC default only when the caller did not provide either
    // the canonical style or a legacy numeric type that still needs conversion.
    if (data.style === undefined && typeof data.type !== 'number') data.style = 1;
    const normalizedSpeaker = normalizeSpeaker(speaker);
    if (normalizedSpeaker) data.speaker = normalizedSpeaker;
    Object.assign(data, await resolveRollModeData(rollMode, author, getGmUserIds));
    return normalizeChatMessageCreateData(data);
}
