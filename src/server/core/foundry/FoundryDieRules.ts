import { Dice, Results } from '@dice-roller/rpg-dice-roller';

export type NumericDieResult = {
    result: number;
    active: boolean;
    discarded?: boolean;
    rerolled?: boolean;
    exploded?: boolean;
    count?: number;
    success?: boolean;
    failure?: boolean;
};

type RuleKind = 'r' | 'rr' | 'x' | 'xo' | 'k' | 'kh' | 'kl' | 'd' | 'dh' | 'dl'
    | 'min' | 'max' | 'even' | 'odd' | 'cs' | 'cf' | 'df' | 'sf' | 'ms';

export type NumericDieRule = {
    kind: RuleKind;
    notation: string;
    number?: number;
    comparison?: '=' | '<' | '<=' | '>' | '>=';
    target?: number;
};

export type NumericDieSpec = {
    qty: number;
    faces: number;
    formula: string;
    rules: NumericDieRule[];
};

export type PoolRule = Pick<NumericDieRule, 'notation' | 'number' | 'comparison' | 'target'> & {
    kind: 'k' | 'kh' | 'kl' | 'd' | 'dh' | 'dl' | 'cs' | 'cf';
};
export type PoolSpec = { rules: PoolRule[] };

/** Foundry's keep/drop ordering discards the earliest tied result first. */
export function applyKeepDrop(results: NumericDieResult[], keep: boolean, highest: boolean, quantity: number): void {
    const active = results.map((result, index) => ({ result, index })).filter(entry => entry.result.active);
    const discardCount = Math.min(active.length, keep ? Math.max(0, active.length - quantity) : quantity);
    active.sort((a, b) => (highest === keep ? a.result.result - b.result.result
        : b.result.result - a.result.result) || a.index - b.index);
    for (const entry of active.slice(0, discardCount)) {
        entry.result.active = false;
        entry.result.discarded = true;
    }
}

export function applyCount(results: NumericDieResult[], comparison: NumericDieRule['comparison'], target: number,
    kind: 'cs' | 'cf'): void {
    for (const result of results) {
        const match = compare(result.result, comparison, target);
        if (kind === 'cf') { result.failure = match; if (match) delete result.success; }
        else { result.success = match; if (match) delete result.failure; }
        result.count = match ? 1 : 0;
    }
}

const kinds: RuleKind[] = ['even', 'min', 'max', 'odd', 'rr', 'xo', 'kh', 'kl', 'dh', 'dl',
    'cs', 'cf', 'df', 'sf', 'ms', 'r', 'x', 'k', 'd'];
const comparisonPattern = /^(<=|>=|=|<|>)(\d+)/;
const numericPattern = /^(\d+)/;

/** Capture pool modifiers in source order; the expression library reorders its modifier map. */
export function preparePoolRules(formula: string): { expression: string; specs: PoolSpec[] } {
    const specs: PoolSpec[] = [];
    const stack: number[] = [];
    let expression = '';
    for (let i = 0; i < formula.length;) {
        const char = formula[i++];
        expression += char;
        if (char === '{') stack.push(specs.push({ rules: [] }) - 1);
        if (char !== '}') continue;
        const index = stack.pop();
        if (index === undefined) throw new Error('Unbalanced pool formula.');
        const rules = specs[index].rules;
        while (i < formula.length && /[A-Za-z]/.test(formula[i])) {
            const tail = formula.slice(i);
            const match = /^(kh|kl|dh|dl|cs|cf|k|d)/i.exec(tail);
            if (!match) break;
            const kind = match[1].toLowerCase() as PoolRule['kind'];
            const start = i;
            i += match[0].length;
            const rule: PoolRule = { kind, notation: '' };
            const remainder = formula.slice(i);
            if (kind === 'cs' || kind === 'cf') {
                const comparison = /^(<=|>=|=|<|>)?(\d+)/.exec(remainder);
                if (comparison) {
                    if (comparison[1]) rule.comparison = comparison[1] as PoolRule['comparison'];
                    rule.target = readNumber(comparison[2]);
                    i += comparison[0].length;
                }
            } else {
                const number = numericPattern.exec(remainder);
                if (number) { rule.number = readNumber(number[1]); i += number[0].length; }
            }
            rule.notation = formula.slice(start, i).toLowerCase();
            rules.push(rule);
        }
    }
    if (stack.length) throw new Error('Unbalanced pool formula.');
    return { expression, specs };
}

function readNumber(value: string): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > 1_000_000_000) throw new Error('Modifier value exceeds the supported limit.');
    return number;
}

/** Strip only recognized Foundry numeric-die modifiers before using the bounded expression parser. */
export function prepareNumericDice(formula: string): { expression: string; specs: NumericDieSpec[] } {
    const specs: NumericDieSpec[] = [];
    let expression = '';
    for (let i = 0; i < formula.length;) {
        const previous = i ? formula[i - 1] : '';
        const base = /^(\d*)[dD](\d+)/.exec(formula.slice(i));
        if (!base || /[A-Za-z0-9_.]/.test(previous)) {
            expression += formula[i++];
            continue;
        }
        const start = i;
        i += base[0].length;
        const rules: NumericDieRule[] = [];
        while (i < formula.length && /[A-Za-z]/.test(formula[i])) {
            const tail = formula.slice(i);
            const kind = kinds.find(candidate => tail.toLowerCase().startsWith(candidate));
            if (!kind) break;
            const ruleStart = i;
            i += kind.length;
            const rule: NumericDieRule = { kind, notation: '' };
            const remainder = formula.slice(i);
            if (kind === 'r' || kind === 'rr' || kind === 'x' || kind === 'xo') {
                const first = numericPattern.exec(remainder);
                if (first) { rule.number = readNumber(first[1]); i += first[0].length; }
                const comparison = comparisonPattern.exec(formula.slice(i));
                if (comparison) {
                    rule.comparison = comparison[1] as NumericDieRule['comparison'];
                    rule.target = readNumber(comparison[2]);
                    i += comparison[0].length;
                } else if (rule.number !== undefined) {
                    rule.target = rule.number;
                    rule.number = undefined;
                }
            } else if (['k', 'kh', 'kl', 'd', 'dh', 'dl', 'min', 'max', 'ms'].includes(kind)) {
                if (kind === 'ms') {
                    const comparison = /^(<=|>=|=|<|>)?(\d+)/.exec(remainder);
                    if (!comparison) throw new Error('Margin modifier requires a target.');
                    if (comparison[1]) rule.comparison = comparison[1] as NumericDieRule['comparison'];
                    rule.target = readNumber(comparison[2]);
                    i += comparison[0].length;
                } else {
                    const number = numericPattern.exec(remainder);
                    if (number) { rule.number = readNumber(number[1]); i += number[0].length; }
                    else if (kind === 'min' || kind === 'max') throw new Error('Min/max modifier requires a target.');
                }
            } else if (['cs', 'cf', 'df', 'sf'].includes(kind)) {
                const comparison = /^(<=|>=|=|<|>)?(\d+)/.exec(remainder);
                if (comparison) {
                    if (comparison[1]) rule.comparison = comparison[1] as NumericDieRule['comparison'];
                    rule.target = readNumber(comparison[2]);
                    i += comparison[0].length;
                }
            }
            rule.notation = formula.slice(ruleStart, i).toLowerCase();
            rules.push(rule);
        }
        specs.push({ qty: base[1] ? readNumber(base[1]) : 1, faces: readNumber(base[2]),
            formula: formula.slice(start, i), rules });
        expression += base[0].toLowerCase();
    }
    return { expression, specs };
}

function compare(value: number, operator: NumericDieRule['comparison'], target: number): boolean {
    switch (operator ?? '=') {
        case '=': return value === target;
        case '<': return value < target;
        case '<=': return value <= target;
        case '>': return value > target;
        case '>=': return value >= target;
    }
}

export function evaluateNumericDie(die: Dice.StandardDice, spec: NumericDieSpec, consume: () => void): {
    results: NumericDieResult[];
    rolls: Results.RollResults;
    total: number;
    options: Record<string, number>;
} {
    const results: NumericDieResult[] = [];
    const options: Record<string, number> = {};
    const roll = () => {
        consume();
        results.push({ result: die.rollOnce().value, active: true });
    };
    for (let n = 0; n < spec.qty; n++) roll();

    for (const rule of spec.rules) {
        const kind = rule.kind;
        if (kind === 'r' || kind === 'rr' || kind === 'x' || kind === 'xo') {
            const initial = results.length;
            let remaining = rule.number ?? Infinity;
            for (let i = 0; i < results.length && remaining > 0; i++) {
                if ((kind === 'r' || kind === 'xo') && i >= initial) break;
                const result = results[i];
                if (!result.active || !compare(result.result, rule.comparison,
                    rule.target ?? (kind.startsWith('r') ? 1 : spec.faces))) continue;
                if (kind.startsWith('r')) { result.rerolled = true; result.active = false; }
                else result.exploded = true;
                roll();
                remaining--;
            }
            continue;
        }
        if (kind === 'k' || kind === 'kh' || kind === 'kl' || kind === 'd' || kind === 'dh' || kind === 'dl') {
            const keep = kind.startsWith('k');
            const highest = kind === 'k' || kind === 'kh' || kind === 'dh';
            applyKeepDrop(results, keep, highest, rule.number || 1);
            continue;
        }
        if (kind === 'min' || kind === 'max') {
            for (const result of results) {
                if (kind === 'min' ? result.result < rule.number! : result.result > rule.number!) {
                    result.count = rule.number;
                    result.rerolled = true;
                }
            }
            continue;
        }
        if (kind === 'cs' || kind === 'cf' || kind === 'even' || kind === 'odd') {
            if (kind === 'cs' || kind === 'cf') {
                if (rule.target === undefined) throw new Error('Success/failure count requires an explicit target.');
                applyCount(results, rule.comparison, rule.target, kind);
                continue;
            }
            for (const result of results) {
                const match = kind === 'even' ? result.result % 2 === 0 : result.result % 2 !== 0;
                result.success = match;
                result.count = match ? 1 : 0;
            }
            continue;
        }
        if (kind === 'df' || kind === 'sf') {
            for (const result of results) {
                if (rule.target !== undefined) {
                    if (compare(result.result, rule.comparison, rule.target)) {
                        result.failure = true;
                        delete result.success;
                    }
                } else if (result.success === false) {
                    result.failure = true;
                    delete result.success;
                }
                if (result.failure) result.count = kind === 'df' ? -1 : -result.result;
            }
            continue;
        }
        if (kind === 'ms') {
            options[rule.comparison === '<' || rule.comparison === '<=' ? 'marginFailure' : 'marginSuccess'] = rule.target!;
        }
    }
    const rolls = new Results.RollResults(results.map(result => new Results.RollResult({
        value: result.result, initialValue: result.result, calculationValue: result.count ?? result.result,
    }, [], result.active)));
    let total = rolls.value;
    if (options.marginSuccess) total -= options.marginSuccess;
    else if (options.marginFailure) total = options.marginFailure - total;
    return { results, rolls, total, options };
}
