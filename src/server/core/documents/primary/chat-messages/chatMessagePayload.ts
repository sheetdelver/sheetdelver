import type { ChatSendBody } from '@server/shared/types/documents';
import { FoundryUserRole } from '@server/core/documents/primary/base/ownership';

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeSpeaker(speaker: ChatSendBody['speaker'] | unknown): ChatSendBody['speaker'] | undefined {
    if (!speaker) return undefined;
    if (typeof speaker === 'string') return { alias: speaker };
    return isRecord(speaker) ? speaker as ChatSendBody['speaker'] : undefined;
}

export async function resolveRollModeData(
    mode: string | undefined,
    userId: string | null | undefined,
    getUsers: () => Promise<any[]>,
): Promise<Record<string, unknown>> {
    if (!mode || mode === 'publicroll' || mode === 'public') return {};
    if (mode === 'selfroll' || mode === 'self') return { whisper: userId ? [userId] : [] };

    const users = await getUsers();
    const gmIds = users
        .filter((u: any) => (u.role || u.permissions?.role || 0) >= FoundryUserRole.ASSISTANT)
        .map((u: any) => u._id || u.id)
        .filter((id: unknown): id is string => typeof id === 'string');
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
    getUsers: () => Promise<any[]>;
    extra?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
    const { content, author, rollMode, speaker, getUsers, extra } = options;
    if (!author) throw new Error('Cannot send message: Author ID missing');

    const data: Record<string, unknown> = {
        ...(extra || {}),
        content,
        type: extra?.type ?? 1,
        author,
    };
    const normalizedSpeaker = normalizeSpeaker(speaker);
    if (normalizedSpeaker) data.speaker = normalizedSpeaker;
    Object.assign(data, await resolveRollModeData(rollMode, author, getUsers));
    return data;
}
