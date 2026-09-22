import type { DicePresentation } from './presentation';
import type { DiceSoundSettings } from './collisionAudio';
import { diceRegions, type DiceRegion } from './viewport';

export interface DiceBehavior {
    ownRollsOnly: boolean;
    displayDurationMs: number;
    lowEffects: boolean;
    mutePrivateRolls: boolean;
    showResultsImmediately: boolean;
    hideEffect: 'none' | 'fade';
    settlementEffect?: 'none' | 'highlight' | 'breathing' | 'crescendo';
    throwForce?: 'soft' | 'normal' | 'strong';
    shadowQuality?: 'low' | 'standard';
    engravedLabels?: boolean;
    highDpi?: boolean;
    region?: DiceRegion;
}

export const defaultDiceBehavior: DiceBehavior = {
    ownRollsOnly: false, displayDurationMs: 1800, lowEffects: false, mutePrivateRolls: true,
    showResultsImmediately: false, hideEffect: 'none',
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
        showResultsImmediately: data.showResultsImmediately === true,
        hideEffect: data.hideEffect === 'fade' ? 'fade' : 'none',
        ...(data.settlementEffect === 'highlight' || data.settlementEffect === 'breathing' || data.settlementEffect === 'crescendo'
            ? { settlementEffect: data.settlementEffect } : {}),
        ...(data.throwForce === 'soft' || data.throwForce === 'strong' ? { throwForce: data.throwForce } : {}),
        ...(data.shadowQuality === 'low' ? { shadowQuality: 'low' as const } : {}),
        ...(data.engravedLabels === false ? { engravedLabels: false } : {}),
        ...(data.highDpi === true ? { highDpi: true } : {}),
        ...(typeof data.region === 'string' && Object.hasOwn(diceRegions, data.region) && data.region !== 'full'
            ? { region: data.region as DiceRegion } : {}),
    };
}

export function allowsDicePresentation(roll: DicePresentation, behavior: DiceBehavior, userId: string | null): boolean {
    return !behavior.ownRollsOnly || (!!userId && roll.authorId === userId);
}

export function diceSoundForRoll(sound: DiceSoundSettings, behavior: DiceBehavior, roll: DicePresentation): DiceSoundSettings {
    return behavior.mutePrivateRolls && roll.privateRoll ? { ...sound, enabled: false } : sound;
}
