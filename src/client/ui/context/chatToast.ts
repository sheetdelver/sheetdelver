import sanitizeHtml from 'sanitize-html';
import type { ChatMessageDto } from '@shared/contracts/chat';

export interface ChatToastSettings {
    enabled: boolean;
    durationMs: number;
}

export const defaultChatToastSettings: ChatToastSettings = { enabled: true, durationMs: 5000 };

export function normalizeChatToastSettings(value: unknown): ChatToastSettings {
    const data = value && typeof value === 'object' ? value as Partial<ChatToastSettings> : {};
    return {
        enabled: data.enabled !== false,
        durationMs: typeof data.durationMs === 'number' && Number.isFinite(data.durationMs)
            ? Math.round(Math.max(1000, Math.min(15000, data.durationMs)) / 500) * 500 : 5000,
    };
}

/** Strip markup before decoding entities, without loading HTML resources. */
export function chatToastContent(message: ChatMessageDto): { title: string; content: string } {
    const author = typeof message.user === 'string' ? message.user.slice(0, 80) : 'Unknown';
    if (message.isContentVisible === false) return { title: author, content: 'Privately rolled dice. ???' };
    if (typeof message.rollTotal === 'number' && Number.isFinite(message.rollTotal)) {
        return { title: author, content: `${message.rollFormula || 'Roll'} = ${message.rollTotal}`.slice(0, 240) };
    }
    const text = sanitizeHtml(message.content || '', {
        allowedTags: [], allowedAttributes: {},
        nonTextTags: ['script', 'style', 'template', 'iframe', 'object', 'embed', 'svg', 'math'],
    });
    const html = new DOMParser().parseFromString(text, 'text/html');
    const content = (html.body.textContent || '').replace(/\s+/g, ' ').trim();
    const summary = content || 'New message';
    return { title: author, content: summary.length > 240 ? `${summary.slice(0, 237)}...` : summary };
}
