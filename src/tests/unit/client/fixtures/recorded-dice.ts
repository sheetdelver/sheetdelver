// Synthetic wire fixtures, not live captures. Shapes follow Foundry 13.351/14.367
// client/dice/roll.mjs and terms/{pool,parenthetical,function}.mjs serializers.
export const recordedDie = (faces: number, ...values: number[]) => ({
    class: 'Die', evaluated: true, number: values.length, faces, options: {}, modifiers: [],
    results: values.map(result => ({ result, active: true })),
});

export const recordedRoll = (terms: unknown[], dice: unknown[] = []) => ({
    class: 'Roll', evaluated: true, formula: 'fixture', total: 0, options: {}, terms, dice,
});

export const recordedPool = (...rolls: ReturnType<typeof recordedRoll>[]) => ({
    class: 'PoolTerm', evaluated: true, options: {}, modifiers: ['kh'],
    terms: rolls.map(roll => roll.formula), rolls,
    results: rolls.map((roll, index) => ({ result: roll.total, active: index === 0 })),
});

export const recordedParenthetical = (roll: ReturnType<typeof recordedRoll>) => ({
    class: 'ParentheticalTerm', evaluated: true, options: {}, term: roll.formula, roll,
});

export const recordedFunction = (...rolls: ReturnType<typeof recordedRoll>[]) => ({
    class: 'FunctionTerm', evaluated: true, options: {}, fn: 'max', result: 0,
    terms: rolls.map(roll => roll.formula), rolls,
});

export function nestedDiceMessage() {
    return {
        _id: 'nested', author: 'player', whisper: [] as string[], blind: false, isContentVisible: true,
        rolls: [recordedRoll([
            recordedPool(recordedRoll([recordedDie(6, 2)]), recordedRoll([recordedDie(20, 17)])),
            recordedParenthetical(recordedRoll([recordedDie(100, 42)])),
            recordedFunction(recordedRoll([recordedDie(6, 5)])),
        ])],
    };
}
