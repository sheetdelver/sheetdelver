import type { DicePresentation } from './presentation';
import type { DiceSoundSettings } from './collisionAudio';

export interface DiceBehavior {
    ownRollsOnly: boolean;
    displayDurationMs: number;
    lowEffects: boolean;
    mutePrivateRolls: boolean;
}

export const defaultDiceBehavior: DiceBehavior = {
    ownRollsOnly: false, displayDurationMs: 1800, lowEffects: false, mutePrivateRolls: true,
};

export function normalizeDiceBehavior(value: unknown): DiceBehavior {
    const data = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
    return {
        ownRollsOnly: data.ownRollsOnly === true,
        displayDurationMs: typeof data.displayDurationMs === 'number' && Number.isFinite(data.displayDurationMs)
            ? Math.round(Math.max(500, Math.min(5000, data.displayDurationMs)) / 100) * 100 : 1800,
        lowEffects: data.lowEffects === true,
        mutePrivateRolls: data.mutePrivateRolls !== false,
    };
}

export function allowsDicePresentation(roll: DicePresentation, behavior: DiceBehavior, userId: string | null): boolean {
    return !behavior.ownRollsOnly || (!!userId && roll.authorId === userId);
}

export function diceSoundForRoll(sound: DiceSoundSettings, behavior: DiceBehavior, roll: DicePresentation): DiceSoundSettings {
    return behavior.mutePrivateRolls && roll.privateRoll ? { ...sound, enabled: false } : sound;
}
