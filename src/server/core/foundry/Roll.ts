import { logger } from '@shared/utils/logger';

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
        const total = 0;

        // Regex to match: (Dice: 1d6[kh|kl]?) OR (Operator: + - * /) OR (Number: 5)
        // Group 1: Dice (e.g. 1d6, 2d20, 2d20kh1, 2d20kl1)
        // Group 2: Operator
        // Group 3: Number
        const regex = /([0-9]+d[0-9]+(?:kh[0-9]*|kl[0-9]*)?)|([+\-*\/])|([0-9]+)/g;

        // We need to tokenize the formula
        // Remove spaces for easier parsing or handle them
        const cleanFormula = this._formula.replace(/\s/g, '');

        let match;
        const lastIndex = 0;

        // Simple arithmetic evaluator tokens
        const evalTokens: (number | string)[] = [];

        while ((match = regex.exec(cleanFormula)) !== null) {
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
                const count = parseInt(parts[0]) || 1;
                const faces = parseInt(parts[1]) || 6;
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
                const num = parseInt(match[3]);
                this._terms.push({
                    class: "NumericTerm",
                    formula: match[3],
                    number: num,
                    options: {}
                });
                evalTokens.push(num);
            }
        }

        // Evaluate the token stream (basic left-to-right with precedence handling is hard, 
        // strictly for this feature we will use Function constructor or simple eval 
        // BUT strict constraint: verify safe tokens only).
        // Since we constructed evalTokens strictly from parsed numbers and known operators, it is safe-ish.

        // Construct string
        const evalString = evalTokens.join(' ');
        try {
            // Basic safety check: only allow numbers and operators
            if (/^[\d\s+\-*\/().]+$/.test(evalString)) {
                 
                this._total = new Function(`return ${evalString}`)();
            } else {
                this._total = 0; // unsafe
            }
        } catch (e) {
            this._total = 0;
        }

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
