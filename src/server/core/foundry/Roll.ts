const MAX_FORMULA_LENGTH = 256;
const MAX_ARITHMETIC_TOKENS = 128;
const MAX_DICE_PER_TERM = 100;
const MAX_DIE_FACES = 1_000_000;
const MAX_NUMERIC_LITERAL = 1_000_000_000;

function evaluateArithmeticTokens(tokens: Array<number | string>): number | null {
    if (tokens.length === 0 || tokens.length > MAX_ARITHMETIC_TOKENS) return null;

    const normalized = [...tokens];
    if (normalized[0] === '+' || normalized[0] === '-') normalized.unshift(0);
    if (normalized.length % 2 === 0) return null;

    // Collapse multiplication/division first, then apply addition/subtraction.
    // This preserves the helper's arithmetic behavior without dynamic code.
    const additiveValues: number[] = [];
    const additiveOperators: string[] = [];
    let current = normalized[0];
    if (typeof current !== 'number' || !Number.isFinite(current)) return null;

    for (let index = 1; index < normalized.length; index += 2) {
        const operator = normalized[index];
        const right = normalized[index + 1];
        if (typeof operator !== 'string' || typeof right !== 'number' || !Number.isFinite(right)) return null;

        if (operator === '*') {
            current *= right;
        } else if (operator === '/') {
            if (right === 0) return null;
            current /= right;
        } else if (operator === '+' || operator === '-') {
            additiveValues.push(current);
            additiveOperators.push(operator);
            current = right;
        } else {
            return null;
        }

        if (!Number.isFinite(current)) return null;
    }

    additiveValues.push(current);
    let total = additiveValues[0];
    for (let index = 0; index < additiveOperators.length; index += 1) {
        total = additiveOperators[index] === '+'
            ? total + additiveValues[index + 1]
            : total - additiveValues[index + 1];
        if (!Number.isFinite(total)) return null;
    }
    return total;
}

/**
 * Lightweight Foundry Roll stand-in used by server route helpers.
 *
 * ADR-0014 Phase 4 only flattened the file out of the one-file `classes/`
 * directory. The evaluator remains intentionally minimal until a future dice
 * or Foundry-runtime pass replaces it.
 */
export class Roll {
    private _formula: string;
    private _data: any;
    private _total: number | undefined;
    private _evaluated: boolean = false;
    private _terms: any[] = [];

    constructor(formula: string, data: any = {}) {
        this._formula = formula;
        this._data = data;
    }

    get total(): number | undefined {
        return this._total;
    }

    get formula(): string {
        return this._formula;
    }

    async evaluate({ minimize = false, maximize = false } = {}): Promise<Roll> {
        if (this._evaluated) return this;

        // basic parser: split by space for now, improve regex later if needed
        // handling simple "NdX + M" or "NdX"
        // Update: Added support for kh (keep highest) and kl (keep lowest)

        this._terms = [];
        // Regex to match: (Dice: 1d6[kh|kl]?) OR (Operator: + - * /) OR (Number: 5)
        // Group 1: Dice (e.g. 1d6, 2d20, 2d20kh1, 2d20kl1)
        // Group 2: Operator
        // Group 3: Number
        const regex = /([0-9]+d[0-9]+(?:kh[0-9]*|kl[0-9]*)?)|([+\-*\/])|([0-9]+)/g;

        const rejectFormula = () => {
            this._terms = [];
            this._total = 0;
            this._evaluated = true;
            return this;
        };

        // Formula and term limits prevent a compact authenticated request from
        // turning the local fallback roller into a CPU or memory exhaustion path.
        if (typeof this._formula !== 'string' || this._formula.length > MAX_FORMULA_LENGTH) {
            return rejectFormula();
        }

        // Whitespace normalization happens only after the raw input is bounded.
        const cleanFormula = this._formula.replace(/\s/g, '');
        if (cleanFormula.length === 0 || cleanFormula.length > MAX_FORMULA_LENGTH) {
            return rejectFormula();
        }

        let match;
        let lastIndex = 0;

        // Simple arithmetic evaluator tokens
        const evalTokens: (number | string)[] = [];

        while ((match = regex.exec(cleanFormula)) !== null) {
            // The old tokenizer silently skipped unsupported text. Requiring
            // contiguous matches makes the accepted grammar explicit.
            if (match.index !== lastIndex) return rejectFormula();
            lastIndex = regex.lastIndex;

            // Dice Term
            if (match[1]) {
                const termStr = match[1];
                let keepMode = 'sum'; // sum, kh, kl
                let keepCount = 1; // Default keep 1
                let cleanDice = termStr;

                // Match kh or kl with optional number
                const khMatch = termStr.match(/kh([0-9]*)/);
                const klMatch = termStr.match(/kl([0-9]*)/);

                if (khMatch) {
                    keepMode = 'kh';
                    keepCount = khMatch[1] ? parseInt(khMatch[1]) : 1;
                    cleanDice = termStr.replace(/kh[0-9]*/, '');
                } else if (klMatch) {
                    keepMode = 'kl';
                    keepCount = klMatch[1] ? parseInt(klMatch[1]) : 1;
                    cleanDice = termStr.replace(/kl[0-9]*/, '');
                }

                const parts = cleanDice.split('d');
                const count = parseInt(parts[0], 10);
                const faces = parseInt(parts[1], 10);
                if (
                    !Number.isSafeInteger(count) || count < 1 || count > MAX_DICE_PER_TERM ||
                    !Number.isSafeInteger(faces) || faces < 1 || faces > MAX_DIE_FACES ||
                    !Number.isSafeInteger(keepCount) || keepCount < 1 || keepCount > count
                ) {
                    return rejectFormula();
                }
                const results = [];
                let subTotal = 0;

                for (let i = 0; i < count; i++) {
                    let res = Math.floor(Math.random() * faces) + 1;
                    // logger.info(`[Roll] DEBUG: 1d${faces} raw result: ${res} (min:${minimize}, max:${maximize})`);
                    if (minimize) res = 1;
                    if (maximize) res = faces;
                    results.push({ result: res, active: true });
                }

                // Apply Keep Logic
                if (keepMode === 'kh') {
                    // Keep Highest N
                    results.sort((a, b) => b.result - a.result); // Descending

                    // Keep first keepCount, discard rest
                    results.forEach((r, idx) => {
                        if (idx >= keepCount) r.active = false;
                    });

                    subTotal = results.slice(0, keepCount).reduce((acc, r) => acc + r.result, 0);
                } else if (keepMode === 'kl') {
                    // Keep Lowest N
                    results.sort((a, b) => a.result - b.result); // Ascending

                    // Keep first keepCount, discard rest
                    results.forEach((r, idx) => {
                        if (idx >= keepCount) r.active = false;
                    });

                    subTotal = results.slice(0, keepCount).reduce((acc, r) => acc + r.result, 0);
                } else {
                    // Sum all
                    subTotal = results.reduce((acc, r) => acc + r.result, 0);
                }


                this._terms.push({
                    class: "Die",
                    formula: termStr,
                    number: count,
                    faces: faces,
                    results: results,
                    options: { flavor: keepMode !== 'sum' ? keepMode : undefined }
                });
                evalTokens.push(subTotal);
            }
            // Operator Term
            else if (match[2]) {
                this._terms.push({
                    class: "OperatorTerm",
                    formula: match[2],
                    operator: match[2],
                    options: {}
                });
                evalTokens.push(match[2]);
            }
            // Numeric Term
            else if (match[3]) {
                const num = parseInt(match[3], 10);
                if (!Number.isSafeInteger(num) || num > MAX_NUMERIC_LITERAL) return rejectFormula();
                this._terms.push({
                    class: "NumericTerm",
                    formula: match[3],
                    number: num,
                    options: {}
                });
                evalTokens.push(num);
            }

            if (evalTokens.length > MAX_ARITHMETIC_TOKENS) return rejectFormula();
        }

        if (lastIndex !== cleanFormula.length) return rejectFormula();

        this._total = evaluateArithmeticTokens(evalTokens) ?? 0;

        this._evaluated = true;
        return this;
    }

    toJSON(): any {
        return {
            class: "Roll",
            options: {},
            formula: this._formula,
            terms: this._terms,
            total: this._total,
            evaluated: this._evaluated
        };
    }
}
