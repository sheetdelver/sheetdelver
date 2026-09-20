import { LiveChatInbox } from '../../context/liveChatInbox';

export interface DicePresentation {
    id: string;
    notation: string;
    authorId?: string;
    privateRoll?: boolean;
}

const supportedFaces = new Set([4, 6, 8, 10, 12, 20, 100]);
const maxTraversalNodes = 1000;
const maxNestingDepth = 16;
const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null;

/** Display recorded faces only. Never interpret a formula or evaluate a new roll. */
export function toDicePresentation(value: unknown): DicePresentation | null {
    const message = record(value);
    const id = message?._id ?? message?.id;
    if (!message || typeof id !== 'string' || message.isContentVisible === false
        || (message.blind !== undefined && typeof message.blind !== 'boolean')
        || (message.blind && message.isContentVisible !== true) || !Array.isArray(message.rolls)
        || !message.rolls.length || message.rolls.length > 10) return null;
    // A GM's blind roll can have the author as its sole recipient without being a Self roll.
    if (!message.blind && typeof message.author === 'string' && Array.isArray(message.whisper)
        && message.whisper.length > 0 && message.whisper.every(id => id === message.author)) return null;
    const dice: string[] = [];
    const results: number[] = [];
    const ancestors = new Set<object>();
    let nodes = 0;

    function enter(value: unknown, depth: number): Record<string, unknown> | null {
        const node = record(value);
        if (!node || ++nodes > maxTraversalNodes || depth > maxNestingDepth || ancestors.has(node)) return null;
        ancestors.add(node);
        return node;
    }

    function visitRoll(value: unknown, depth: number): boolean {
        const roll = enter(value, depth);
        if (!roll) return false;
        try {
            if (roll.evaluated !== true || !Array.isArray(roll.terms) || roll.terms.length > 100) return false;
            // Serialized Roll.dice is retained _dice, not the runtime getter's aggregate of all terms.
            if (roll.dice !== undefined) {
                if (!Array.isArray(roll.dice) || roll.dice.length > 100
                    || !roll.dice.every(die => record(die)?.class === 'Die' && visitTerm(die, depth))) return false;
            }
            return roll.terms.every(term => visitTerm(term, depth));
        } finally {
            ancestors.delete(roll);
        }
    }

    function visitTerm(value: unknown, depth: number): boolean {
        const term = enter(value, depth);
        if (!term) return false;
        try {
            if (term.evaluated === false) return false;
            if (term.class === 'NumericTerm' || term.class === 'OperatorTerm') return true;
            if (term.class === 'ParentheticalTerm') {
                return term.evaluated === true && typeof term.term === 'string' && visitRoll(term.roll, depth + 1);
            }
            if (term.class === 'PoolTerm' || term.class === 'DicePool'
                || term.class === 'FunctionTerm' || term.class === 'MathTerm') {
                if (term.evaluated !== true || !Array.isArray(term.rolls) || !term.rolls.length
                    || term.rolls.length > 100 || !Array.isArray(term.terms)
                    || term.terms.length !== term.rolls.length || !term.terms.every(term => typeof term === 'string')) return false;
                return term.rolls.every(roll => visitRoll(roll, depth + 1));
            }
            if (term.class !== 'Die' || !supportedFaces.has(term.faces as number)
                || !Array.isArray(term.results) || !term.results.length || term.results.length > 24) return false;
            for (const rawResult of term.results) {
                if (++nodes > maxTraversalNodes) return false;
                const result = record(rawResult)?.result;
                if (typeof result !== 'number' || !Number.isInteger(result) || result < 1
                    || result > (term.faces as number)) return false;
                if (results.length + (term.faces === 100 ? 2 : 1) > 24) return false;
                if (term.faces === 100) {
                    // Upstream uses 100 for the "00" face and 10 for the "0" face.
                    dice.push('1d100', '1d10');
                    results.push(Math.floor((result % 100) / 10) * 10 || 100, result % 10 || 10);
                } else {
                    dice.push(`1d${term.faces}`);
                    results.push(result);
                }
            }
            return true;
        } finally {
            ancestors.delete(term);
        }
    }

    if (!message.rolls.every(roll => visitRoll(roll, 0))) return null;
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
        ...(message.blind || (Array.isArray(message.whisper) && message.whisper.length) ? { privateRoll: true } : {}),
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
