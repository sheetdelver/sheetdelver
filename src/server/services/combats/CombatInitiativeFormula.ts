import type { PreparedActorData, SystemAdapter } from '@shared/sdk';
import { BaseSystemAdapter } from '@shared/sdk';
import { isSafeCombatStatPath } from '@shared/contracts/combatStatAttributes';

export type InitiativeFormulaSource = 'module' | 'gm' | 'core';
export interface EffectiveInitiativeFormula {
    source: InitiativeFormulaSource;
    formula: string;
    rollAvailable: boolean;
    advantageAvailable: boolean;
}

const TERM = '(?:[1-9][0-9]{0,2}d[1-9][0-9]{0,3}|(?:[0-9]{1,9})(?:\\.[0-9]{1,3})?|@[A-Za-z_][A-Za-z0-9_.]*)';
const FORMULA = new RegExp(`^\\s*[+-]?\\s*${TERM}(?:\\s*[+-]\\s*${TERM}){0,31}\\s*$`, 'i');
const REFERENCE = /@([A-Za-z_][A-Za-z0-9_.]*)/g;

export function validInitiativeFallback(value: unknown): value is string {
    if (typeof value !== 'string' || !value.trim() || value.length > 160 || !FORMULA.test(value)) return false;
    const diceCount = [...value.matchAll(/\b([1-9][0-9]{0,2})d[1-9][0-9]{0,3}\b/gi)]
        .reduce((sum, match) => sum + Number(match[1]), 0);
    if (diceCount > 100) return false;
    for (const match of value.matchAll(REFERENCE)) {
        if (!isSafeCombatStatPath(match[1])) return false;
    }
    return true;
}

function preparedNumber(actor: PreparedActorData, path: string): number | null {
    let value: unknown = actor;
    for (const segment of path.split('.')) {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || !Object.prototype.hasOwnProperty.call(value, segment)) return null;
        value = (value as Record<string, unknown>)[segment];
    }
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveReferences(formula: string, actor: PreparedActorData): string | null {
    let missing = false;
    const resolved = formula.replace(REFERENCE, (_token, path: string) => {
        const number = preparedNumber(actor, path);
        if (number === null) { missing = true; return '0'; }
        return number < 0 ? `(${number})` : String(number);
    });
    if (missing) return null;
    // Keep the evaluated formula in the same simple arithmetic grammar as
    // the saved expression; do not depend on Foundry accepting nested signs.
    return resolved.replace(/([+-])\s*\(-(\d+(?:\.\d+)?)\)/g,
        (_whole, sign: string, magnitude: string) => `${sign === '+' ? '-' : '+'}${magnitude}`)
        .replace(/^\s*\(-(\d+(?:\.\d+)?)\)/, '-$1');
}

export function effectiveInitiativeFormula(adapter: SystemAdapter | null, actor: PreparedActorData,
    gmFallback: string | null): EffectiveInitiativeFormula {
    const hook = adapter?.getInitiativeFormula;
    let moduleFormula = '';
    if (typeof hook === 'function' && hook !== BaseSystemAdapter.prototype.getInitiativeFormula) {
        try { moduleFormula = hook.call(adapter, actor)?.trim() || ''; }
        catch { return { source: 'module', formula: '', rollAvailable: false, advantageAvailable: false }; }
    }
    const source: InitiativeFormulaSource = moduleFormula ? 'module' : gmFallback ? 'gm' : 'core';
    const raw = moduleFormula || gmFallback || '1d20';
    const formula = raw.includes('@') ? resolveReferences(raw, actor) : raw;
    return { source, formula: formula ?? raw, rollAvailable: formula !== null,
        advantageAvailable: formula !== null && /^(?:1d20|2d20k[hl]1)(?!\d)/i.test(formula.trim()) };
}
