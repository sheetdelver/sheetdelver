import { LiveChatInbox } from '../../context/liveChatInbox';

export interface DicePresentation {
    id: string;
    notation: string;
    authorId?: string;
    privateRoll?: boolean;
}

const supportedFaces = new Set([4, 6, 8, 10, 12, 20, 100]);
const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null;

/** Display recorded faces only. Never interpret a formula or evaluate a new roll. */
export function toDicePresentation(value: unknown): DicePresentation | null {
    const message = record(value);
    const id = message?._id ?? message?.id;
    if (!message || typeof id !== 'string' || message.isContentVisible === false || message.blind || !Array.isArray(message.rolls)
        || !message.rolls.length || message.rolls.length > 10) return null;
    // Author-only whispers are self rolls: keep their result in chat, without dice or sound.
    if (typeof message.author === 'string' && Array.isArray(message.whisper)
        && message.whisper.length > 0 && message.whisper.every(id => id === message.author)) return null;
    const dice: string[] = [];
    const results: number[] = [];
    for (const rawRoll of message.rolls) {
        const roll = record(rawRoll);
        if (!roll || roll.evaluated !== true || !Array.isArray(roll.terms) || roll.terms.length > 100) return null;
        for (const rawTerm of roll.terms) {
            const term = record(rawTerm);
            if (!term) return null;
            if (term.class === 'NumericTerm' || term.class === 'OperatorTerm') continue;
            if (term.class !== 'Die' || !supportedFaces.has(term.faces as number)
                || !Array.isArray(term.results) || !term.results.length) return null;
            for (const rawResult of term.results) {
                const result = record(rawResult)?.result;
                if (typeof result !== 'number' || !Number.isInteger(result) || result < 1
                    || result > (term.faces as number)) return null;
                if (results.length + (term.faces === 100 ? 2 : 1) > 24) return null;
                if (term.faces === 100) {
                    // Upstream uses 100 for the "00" face and 10 for the "0" face.
                    dice.push('1d100', '1d10');
                    results.push(Math.floor((result % 100) / 10) * 10 || 100, result % 10 || 10);
                } else {
                    dice.push(`1d${term.faces}`);
                    results.push(result);
                }
            }
        }
    }
    // The renderer merges all sets of the same type, even when non-adjacent.
    // Match that order before assigning forced faces.
    const grouped = new Map<string, number[]>();
    dice.forEach((die, index) => {
        if (!grouped.has(die)) grouped.set(die, []);
        grouped.get(die)!.push(results[index]);
    });
    const groups = [...grouped];
    return dice.length ? {
        id, notation: `${groups.flatMap(([die, faces]) => faces.map(() => die)).join('+')}@${groups.flatMap(([, faces]) => faces).join(',')}`,
        ...(typeof message.author === 'string' ? { authorId: message.author } : {}),
        ...(Array.isArray(message.whisper) && message.whisper.length ? { privateRoll: true } : {}),
    } : null;
}

/** Only live create hints may become animations, never an initial history read. */
export class LiveDiceInbox {
    private inbox = new LiveChatInbox<unknown>();
    created(id: string, now = Date.now()) { this.inbox.created(id, now); }
    consume(messages: readonly unknown[], now = Date.now()): DicePresentation[] {
        return this.inbox.consume(messages, now).map(toDicePresentation)
            .filter((roll): roll is DicePresentation => roll !== null);
    }
    invalidated(id: string) { this.inbox.invalidated(id); }
    reset() { this.inbox.reset(); }
}
