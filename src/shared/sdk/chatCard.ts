import type { ChatCard } from './interfaces';
import { SdkError } from './errors';

/** Validate recorded data without evaluating formulas or interpreting system-specific terms. */
export function serializeEvaluatedRolls(value: unknown): string[] {
    if (!Array.isArray(value)) throw new SdkError('validation', 'Evaluated rolls must be an array.');
    return value.map((entry, index) => {
        try {
            const serialized = typeof entry === 'string' ? entry : JSON.stringify(entry);
            const roll: unknown = JSON.parse(serialized);
            if (!roll || typeof roll !== 'object' || Array.isArray(roll)) throw new Error();
            const data = roll as Record<string, unknown>;
            if (typeof data.class !== 'string' || !data.class
                || typeof data.formula !== 'string' || !data.formula
                || typeof data.total !== 'number' || !Number.isFinite(data.total)
                || data.evaluated !== true || !Array.isArray(data.terms)) throw new Error();
            return serialized;
        } catch {
            throw new SdkError('validation', `Evaluated roll ${index} must contain a serialized, evaluated Roll with class, formula, finite total and terms.`);
        }
    });
}

/** Shared by the real request runtime and the SDK test host; no transport or UI dependencies. */
export function createChatCardMessage(card: ChatCard): Record<string, unknown> {
    const { evaluatedRolls, ...displayCard } = card;
    if (card.rolls !== undefined && (!Array.isArray(card.rolls) || card.rolls.some(roll =>
        !roll || typeof roll !== 'object' || typeof roll.formula !== 'string'
        || typeof roll.total !== 'number' || !Number.isFinite(roll.total)))) {
        throw new SdkError('validation', 'ChatCard.rolls contains display summaries; use evaluatedRolls for serialized rolls.');
    }
    if (evaluatedRolls !== undefined && (!Array.isArray(evaluatedRolls)
        || evaluatedRolls.some(roll => typeof roll !== 'string'))) {
        throw new SdkError('validation', 'ChatCard.evaluatedRolls must contain serialized Roll strings.');
    }
    const rolls = evaluatedRolls === undefined ? [] : serializeEvaluatedRolls(evaluatedRolls);
    return {
        content: String(card.content ?? card.flavor ?? card.title ?? ''),
        flags: { sheetDelver: { chatCard: displayCard } },
        ...(card.flavor ? { flavor: card.flavor } : {}),
        ...(rolls.length ? { rolls } : {}),
    };
}
