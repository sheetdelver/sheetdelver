import type { ChatMessageDto } from '@shared/contracts/chat';
import { sanitizeRichHtml } from '@shared/security/safeHtml';

export function messageId(message: ChatMessageDto): string {
    return message._id ?? message.id ?? '';
}
export function orderedMessages(messages: readonly ChatMessageDto[]): ChatMessageDto[] {
    return [...messages].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}
export function messageAuthor(message: ChatMessageDto): string {
    if (message.isContentVisible !== false && message.speaker && typeof message.speaker === 'object') {
        const alias = (message.speaker as { alias?: unknown }).alias;
        if (typeof alias === 'string' && alias) return alias;
    }
    return message.user || 'Unknown';
}
export function messageRolls(message: ChatMessageDto): { formula: string; total: number }[] {
    if (message.isContentVisible === false) return [];
    const rolls = (Array.isArray(message.rolls) ? message.rolls : []).flatMap(value => {
        let roll: unknown = value;
        if (typeof value === 'string') { try { roll = JSON.parse(value); } catch { return []; } }
        if (!roll || typeof roll !== 'object') return [];
        const { formula, total } = roll as { formula?: unknown; total?: unknown };
        return typeof total === 'number' && Number.isFinite(total)
            ? [{ formula: typeof formula === 'string' ? formula : 'Roll', total }] : [];
    });
    if (!rolls.length && typeof message.rollTotal === 'number' && Number.isFinite(message.rollTotal)) {
        rolls.push({ formula: message.rollFormula || 'Roll', total: message.rollTotal });
    }
    return rolls;
}

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Inline syntax is transformed before the final sanitizer, including generated controls. */
export function formatChatContent(content: string, foundryUrl?: string, controls = { roll: true, check: true }) {
    const html = content.replace(/@UUID\[[^\]]+\]\{([^}]+)\}/g, '$1').replace(/\[\[(.*?)\]\]/gi, (match, value: string) => {
        const clean = value.replace(/&nbsp;/g, ' ').trim();
        const check = clean.match(/^check\s+(\d+)\s+(\w+)$/i);
        if (check) return `<button ${controls.check ? '': 'disabled'} data-action="roll-check" data-dc="${check[1]}" data-stat="${check[2]}">${check[2]} DC ${check[1]}</button>`;
        const roll = clean.match(/^\/(?:roll|r)\s+(.+)$/i);
        return roll ? `<button ${controls.roll ? '': 'disabled'} data-action="roll-formula" data-formula="${escape(roll[1])}">Roll ${escape(roll[1])}</button>` : match;
    });
    return sanitizeRichHtml(html, { foundryBaseUrl: foundryUrl });
}
