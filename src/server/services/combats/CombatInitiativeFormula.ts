import type { PreparedActorData, SystemAdapter } from '@shared/sdk';
import { BaseSystemAdapter } from '@shared/sdk';
import { isSafeCombatStatPath } from '@shared/contracts/combatStatAttributes';
import { RollFormulaError, validateRollFormula } from '@server/core/foundry/Roll';

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

function resolveReferences(formula: string, actor?: PreparedActorData): string {
    const resolved = formula.replace(REFERENCE, (_token, path: string) => {
        const number = actor ? preparedNumber(actor, path) : null;
        if (number === null) throw new RollFormulaError(`Missing or non-numeric initiative attribute: @${path}.`);
        return number < 0 ? `(${number})` : String(number);
    });
    // Keep the evaluated formula in the same simple arithmetic grammar as
    // the saved expression; do not depend on Foundry accepting nested signs.
    return resolved.replace(/([+-])\s*\(-(\d+(?:\.\d+)?)\)/g,
        (_whole, sign: string, magnitude: string) => `${sign === '+' ? '-' : '+'}${magnitude}`)
        .replace(/^\s*\(-(\d+(?:\.\d+)?)\)/, '-$1');
}

/** GM expressions alone use Core's bounded prepared-Actor reference grammar. */
export function validateInitiativeOverride(formula: string, actor?: PreparedActorData): string {
    if (!validInitiativeFallback(formula)) throw new RollFormulaError('Use dice, numbers, +/− and safe numeric @system or @derived paths.');
    const resolved = resolveReferences(formula, actor);
    validateRollFormula(resolved);
    return resolved;
}

export function effectiveInitiativeFormula(adapter: SystemAdapter | null, actor: PreparedActorData,
    gmOverride: string | null): EffectiveInitiativeFormula {
    // An explicit override is authoritative, including failure. Do not run a
    // module hook or silently fall back when a GM reference is unavailable.
    if (gmOverride !== null) {
        try {
            const formula = validateInitiativeOverride(gmOverride, actor);
            return { source: 'gm', formula, rollAvailable: true,
                advantageAvailable: /^(?:1d20|2d20k[hl]1)(?!\d)/i.test(formula.trim()) };
        } catch {
            return { source: 'gm', formula: gmOverride, rollAvailable: false, advantageAvailable: false };
        }
    }
    const hook = adapter?.getInitiativeFormula;
    let moduleFormula = '';
    if (typeof hook === 'function' && hook !== BaseSystemAdapter.prototype.getInitiativeFormula) {
        try { moduleFormula = hook.call(adapter, actor)?.trim() || ''; }
        catch { return { source: 'module', formula: '', rollAvailable: false, advantageAvailable: false }; }
    }
    const source: InitiativeFormulaSource = moduleFormula ? 'module' : 'core';
    const formula = moduleFormula || '1d20';
    return { source, formula, rollAvailable: true,
        advantageAvailable: /^(?:1d20|2d20k[hl]1)(?!\d)/i.test(formula.trim()) };
}
