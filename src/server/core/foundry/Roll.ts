import { Dice, Modifiers, NumberGenerator, Parser, Results, RollGroup } from '@dice-roller/rpg-dice-roller';

const MAX_FORMULA_LENGTH = 256;
const MAX_TERMS = 128;
const MAX_DEPTH = 16;
const MAX_DICE_PER_TERM = 100;
const MAX_DICE = 1000;
const MAX_DIE_FACES = 1_000_000;
const MAX_NUMBER = 1_000_000_000;
const operators = new Set(['+', '-', '*', '/']);
const syntax = new Set([...operators, '(', ')', ',', 'max(', 'min(', 'abs(', 'floor(', 'ceil(']);

type Token = number | string | Dice.StandardDice | RollGroup;
type Result = number | string | Results.RollResults | Results.ResultGroup;
type Term = Record<string, any>;
type RecordedRoll = { class: 'Roll'; options: object; formula: string; terms: Term[]; dice: Term[]; total: number; evaluated: true };

export class RollFormulaError extends Error {
    readonly status = 400;
    constructor(message = 'Invalid or unsupported dice formula.') {
        super(message);
        this.name = 'RollFormulaError';
    }
}

function finite(value: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
        throw new RollFormulaError('Dice formula produced an invalid or excessively large result.');
    }
    return value;
}

function parse(formula: string): Token[] {
    if (typeof formula !== 'string' || !formula.trim() || formula.length > MAX_FORMULA_LENGTH
        || !/^[\da-zA-Z\s.+*/(){},-]+$/.test(formula)) throw new RollFormulaError();
    // Bound nesting before invoking the library's recursive grammar.
    let depth = 0;
    for (const char of formula) {
        if ((char === '(' || char === '{') && ++depth > MAX_DEPTH) throw new RollFormulaError('Dice formula is nested too deeply.');
        if ((char === ')' || char === '}') && --depth < 0) throw new RollFormulaError();
    }
    if (depth !== 0) throw new RollFormulaError();
    // Foundry defaults bare keep-highest/lowest to one; the library requires a count.
    const normalized = formula.trim().replace(/^([+-])/, '0$1').replace(/k([hl])(?!\d)/g, (_, mode) => `k${mode}1`);
    const tokens: Token[] = Parser.parse(normalized);
    let terms = 0;
    let dice = 0;
    function validate(list: (Token | Token[])[]) {
        for (const token of list) {
            if (++terms > MAX_TERMS) throw new RollFormulaError('Dice formula has too many terms.');
            if (typeof token === 'number') {
                if (!Number.isFinite(token) || Math.abs(token) > MAX_NUMBER) throw new RollFormulaError();
            } else if (typeof token === 'string') {
                if (!syntax.has(token)) throw new RollFormulaError();
            } else if (token instanceof Dice.StandardDice || token instanceof RollGroup) {
                if (token.description) throw new RollFormulaError();
                const count = token instanceof RollGroup ? token.expressions.length : token.qty;
                for (const modifier of token.modifiers?.values() ?? []) {
                    if (!(modifier instanceof Modifiers.KeepModifier) || modifier instanceof Modifiers.DropModifier
                        || modifier.qty < 1 || modifier.qty > count) throw new RollFormulaError('Only kh/kl keep modifiers are supported.');
                }
                if (token instanceof RollGroup) validate(token.expressions);
                else {
                    if (token.name !== 'standard' || !Number.isSafeInteger(token.sides) || token.sides < 1 || token.sides > MAX_DIE_FACES
                        || !Number.isSafeInteger(token.qty) || token.qty < 1 || token.qty > MAX_DICE_PER_TERM
                        || (dice += token.qty) > MAX_DICE) throw new RollFormulaError('Dice quantity or faces exceed the supported limits.');
                }
            } else if (Array.isArray(token)) validate(token);
            else throw new RollFormulaError();
        }
    }
    validate(tokens);
    return tokens;
}

const notation = (tokens: Token[]): string => tokens.map(token =>
    typeof token === 'object' ? token.notation : String(token)).join('');
const numeric = (number: number): Term => ({ class: 'NumericTerm', number, options: {}, evaluated: true });

/** Adapt evaluated library results, never re-roll or ask the browser to evaluate. */
function record(tokens: Token[], results: Result[], formula = notation(tokens)): RecordedRoll {
    const total = finite(new Results.ResultGroup(results).value);
    const terms: Term[] = [];
    const allDice: Term[] = [];
    const compound = tokens.some(token => typeof token === 'string' && !operators.has(token));
    tokens.forEach((token, index) => {
        const result = results[index];
        if (typeof token === 'number') terms.push(numeric(token));
        else if (typeof token === 'string') {
            if (operators.has(token)) terms.push({ class: 'OperatorTerm', operator: token, options: {} });
        } else if (token instanceof Dice.StandardDice && result instanceof Results.RollResults) {
            const term: Term = {
                class: 'Die', number: token.qty, faces: token.sides, formula: token.notation,
                modifiers: [...(token.modifiers?.values() ?? [])].map(modifier => modifier.notation),
                results: result.rolls.map(roll => ({ result: roll.value, active: roll.useInTotal, discarded: !roll.useInTotal })),
                options: {}, evaluated: true,
            };
            terms.push(term);
            allDice.push(term);
        } else if (token instanceof RollGroup && result instanceof Results.ResultGroup) {
            const children = result.results as Results.ResultGroup[];
            const rolls = token.expressions.map((expression, i) => record(expression, children[i].results));
            terms.push({ class: 'PoolTerm', terms: rolls.map(roll => roll.formula), rolls,
                modifiers: [...(token.modifiers?.values() ?? [])].map(modifier => modifier.notation),
                results: children.map(child => ({ result: finite(child.value), active: child.useInTotal, discarded: !child.useInTotal })),
                options: {}, evaluated: true });
            for (const roll of rolls) collectDice(roll, allDice);
        } else throw new RollFormulaError();
    });
    // Like native intermediate-term reduction, retain inner dice separately from
    // the evaluated arithmetic. Simple rolls/pools keep their normal term structure.
    return { class: 'Roll', options: {}, formula, total, evaluated: true,
        terms: compound ? [numeric(total)] : terms, dice: compound ? allDice : [] };
}

function collectDice(roll: RecordedRoll, target: Term[]) {
    target.push(...roll.dice);
    for (const term of roll.terms) {
        if (term.class === 'Die') target.push(term);
        else if (term.class === 'PoolTerm') for (const child of term.rolls) collectDice(child, target);
    }
}

/** Shared, server-only bounded evaluator used by tray, actor routes and the SDK. */
export class Roll {
    private evaluated?: RecordedRoll;
    constructor(private readonly _formula: string, _data: unknown = {}) {}
    get total(): number | undefined { return this.evaluated?.total; }
    get formula(): string { return this._formula; }

    async evaluate({ minimize = false, maximize = false } = {}): Promise<Roll> {
        if (this.evaluated) return this;
        const previousEngine = NumberGenerator.generator.engine;
        try {
            const tokens = parse(this._formula);
            // No await while the library's shared RNG is temporarily selected.
            if (maximize) NumberGenerator.generator.engine = NumberGenerator.engines.max;
            else if (minimize) NumberGenerator.generator.engine = NumberGenerator.engines.min;
            const results = tokens.map(token => {
                if (token instanceof RollGroup && token.expressions.length === 1) {
                    // Foundry keeps pool entries, not dice inside the sole entry.
                    return new RollGroup(token.expressions).roll();
                }
                return typeof token === 'object' ? token.roll() : token;
            });
            this.evaluated = record(tokens, results, this._formula);
            return this;
        } catch (error) {
            throw error instanceof RollFormulaError ? error : new RollFormulaError();
        } finally {
            NumberGenerator.generator.engine = previousEngine;
        }
    }

    toJSON(): any {
        return this.evaluated ?? { class: 'Roll', options: {}, formula: this._formula, terms: [], evaluated: false };
    }
}
