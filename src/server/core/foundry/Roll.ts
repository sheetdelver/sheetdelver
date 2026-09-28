import { Dice, NumberGenerator, Parser, Results, RollGroup } from '@dice-roller/rpg-dice-roller';
import { applyCount, applyKeepDrop, evaluateNumericDie, prepareNumericDice, preparePoolRules,
    type NumericDieSpec, type NumericDieResult, type PoolSpec } from './FoundryDieRules';

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
type Term = Record<string, any>;
type RecordedRoll = { class: 'Roll'; options: object; formula: string; terms: Term[]; dice: Term[]; total: number; evaluated: true };
type ParsedFormula = { tokens: Token[]; specs: WeakMap<Dice.StandardDice, NumericDieSpec>;
    pools: WeakMap<RollGroup, PoolSpec> };
type EvaluatedEntry = { token: Token; result: number | string | Results.RollResults | Results.ResultGroup;
    calculation: number | string; dieResults?: NumericDieResult[]; dieOptions?: Record<string, number>;
    children?: EvaluatedRoll[]; poolResults?: NumericDieResult[] };
type EvaluatedRoll = { entries: EvaluatedEntry[]; total: number };

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

function parse(formula: string): ParsedFormula {
    if (typeof formula !== 'string' || !formula.trim() || formula.length > MAX_FORMULA_LENGTH
        || !/^[\da-zA-Z\s.+*/(){},<>=-]+$/.test(formula)) throw new RollFormulaError();
    // Bound nesting before invoking the library's recursive grammar.
    let depth = 0;
    for (const char of formula) {
        if ((char === '(' || char === '{') && ++depth > MAX_DEPTH) throw new RollFormulaError('Dice formula is nested too deeply.');
        if ((char === ')' || char === '}') && --depth < 0) throw new RollFormulaError();
    }
    if (depth !== 0) throw new RollFormulaError();
    // Foundry defaults bare keep-highest/lowest to one; the library requires a count.
    const { expression, specs: scanned } = prepareNumericDice(formula.trim());
    const { expression: poolExpression, specs: scannedPools } = preparePoolRules(expression);
    const hasTargetlessCount = (rules: readonly { kind: string; target?: number }[]) =>
        rules.some(rule => (rule.kind === 'cs' || rule.kind === 'cf') && rule.target === undefined);
    if (scanned.some(spec => hasTargetlessCount(spec.rules))
        || scannedPools.some(spec => hasTargetlessCount(spec.rules))) {
        throw new RollFormulaError('Success/failure count requires an explicit target, such as cs>=5 or cf<=2.');
    }
    const normalized = poolExpression.replace(/^([+-])/, '0$1');
    const tokens: Token[] = Parser.parse(normalized);
    const specs = new WeakMap<Dice.StandardDice, NumericDieSpec>();
    const pools = new WeakMap<RollGroup, PoolSpec>();
    let terms = 0;
    let dice = 0;
    let specIndex = 0;
    let poolIndex = 0;
    function validate(list: (Token | Token[])[]) {
        for (const token of list) {
            if (++terms > MAX_TERMS) throw new RollFormulaError('Dice formula has too many terms.');
            if (typeof token === 'number') {
                if (!Number.isFinite(token) || Math.abs(token) > MAX_NUMBER) throw new RollFormulaError();
            } else if (typeof token === 'string') {
                if (!syntax.has(token)) throw new RollFormulaError();
            } else if (token instanceof Dice.StandardDice || token instanceof RollGroup) {
                if (token.description) throw new RollFormulaError();
                if (token.modifiers?.size) throw new RollFormulaError('Unsupported formula modifier.');
                if (token instanceof RollGroup) {
                    const pool = scannedPools[poolIndex++];
                    if (!pool) throw new RollFormulaError();
                    pools.set(token, pool);
                    validate(token.expressions);
                }
                else {
                    const spec = scanned[specIndex++];
                    if (!spec || spec.qty !== token.qty || spec.faces !== token.sides) {
                        throw new RollFormulaError();
                    }
                    specs.set(token, spec);
                    if (token.name !== 'standard' || !Number.isSafeInteger(token.sides) || token.sides < 1 || token.sides > MAX_DIE_FACES
                        || !Number.isSafeInteger(token.qty) || token.qty < 1 || token.qty > MAX_DICE_PER_TERM
                        || (dice += token.qty) > MAX_DICE) throw new RollFormulaError('Dice quantity or faces exceed the supported limits.');
                }
            } else if (Array.isArray(token)) validate(token);
            else throw new RollFormulaError();
        }
    }
    validate(tokens);
    if (specIndex !== scanned.length || poolIndex !== scannedPools.length) throw new RollFormulaError();
    return { tokens, specs, pools };
}

function notation(tokens: Token[], specs: WeakMap<Dice.StandardDice, NumericDieSpec>, pools: WeakMap<RollGroup, PoolSpec>): string {
    return tokens.map(token => token instanceof Dice.StandardDice ? specs.get(token)?.formula ?? token.notation
        : token instanceof RollGroup ? `{${token.expressions.map(expression => notation(expression, specs, pools)).join(',')}}${pools.get(token)?.rules.map(rule => rule.notation).join('') ?? ''}`
            : String(token)).join('');
}
const numeric = (number: number): Term => ({ class: 'NumericTerm', number, options: {}, evaluated: true });

function evaluateTokens(tokens: Token[], specs: WeakMap<Dice.StandardDice, NumericDieSpec>,
    pools: WeakMap<RollGroup, PoolSpec>, consume: () => void): EvaluatedRoll {
    const entries: EvaluatedEntry[] = tokens.map(token => {
        if (token instanceof Dice.StandardDice) {
            const die = evaluateNumericDie(token, specs.get(token)!, consume);
            return { token, result: die.rolls, calculation: finite(die.total),
                dieResults: die.results, dieOptions: die.options };
        }
        if (token instanceof RollGroup) {
            const children = token.expressions.map(expression => evaluateTokens(expression, specs, pools, consume));
            const poolResults: NumericDieResult[] = children.map(child => ({ result: child.total, active: true }));
            for (const rule of pools.get(token)!.rules) {
                if (rule.kind === 'cs' || rule.kind === 'cf') {
                    if (rule.target === undefined) throw new RollFormulaError('Success/failure count requires an explicit target.');
                    applyCount(poolResults, rule.comparison, rule.target, rule.kind);
                } else {
                    applyKeepDrop(poolResults, rule.kind.startsWith('k'),
                        rule.kind === 'k' || rule.kind === 'kh' || rule.kind === 'dh', rule.number || 1);
                }
            }
            const displayChildren = children.map((child, index) => new Results.ResultGroup(
                child.entries.map(entry => entry.result), [], false, poolResults[index].active));
            return { token, result: new Results.ResultGroup(displayChildren, [], true),
                calculation: finite(poolResults.reduce((sum, result) => sum + (result.active
                    ? result.count ?? result.result : 0), 0)), children, poolResults };
        }
        return { token, result: token, calculation: token };
    });
    return { entries, total: finite(new Results.ResultGroup(entries.map(entry => entry.calculation)).value) };
}

/** Adapt evaluated library results, never re-roll or ask the browser to evaluate. */
function record(evaluated: EvaluatedRoll, specs: WeakMap<Dice.StandardDice, NumericDieSpec>,
    pools: WeakMap<RollGroup, PoolSpec>, formula: string): RecordedRoll {
    const total = evaluated.total;
    const terms: Term[] = [];
    const allDice: Term[] = [];
    const compound = evaluated.entries.some(entry => typeof entry.token === 'string' && !operators.has(entry.token));
    evaluated.entries.forEach(entry => {
        const { token, result } = entry;
        if (typeof token === 'number') terms.push(numeric(token));
        else if (typeof token === 'string') {
            if (operators.has(token)) terms.push({ class: 'OperatorTerm', operator: token, options: {} });
        } else if (token instanceof Dice.StandardDice && result instanceof Results.RollResults) {
            const spec = specs.get(token)!;
            const term: Term = {
                class: 'Die', number: token.qty, faces: token.sides, formula: spec.formula,
                modifiers: spec.rules.map(rule => rule.notation), results: entry.dieResults,
                options: entry.dieOptions ?? {}, evaluated: true,
            };
            terms.push(term);
            allDice.push(term);
        } else if (token instanceof RollGroup && result instanceof Results.ResultGroup) {
            const rolls = entry.children!.map((child, i) => record(child, specs, pools, notation(token.expressions[i], specs, pools)));
            terms.push({ class: 'PoolTerm', terms: rolls.map(roll => roll.formula), rolls,
                modifiers: pools.get(token)!.rules.map(rule => rule.notation),
                results: entry.poolResults,
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
            const { tokens, specs, pools } = parse(this._formula);
            // No await while the library's shared RNG is temporarily selected.
            if (maximize) NumberGenerator.generator.engine = NumberGenerator.engines.max;
            else if (minimize) NumberGenerator.generator.engine = NumberGenerator.engines.min;
            let physicalDice = 0;
            const evaluated = evaluateTokens(tokens, specs, pools, () => {
                if (++physicalDice > MAX_DICE) throw new RollFormulaError('Dice formula produced too many results.');
            });
            this.evaluated = record(evaluated, specs, pools, this._formula);
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
