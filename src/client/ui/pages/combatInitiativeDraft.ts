import { isSafeCombatStatPath } from '@shared/contracts/combatStatAttributes';

/** Edit a GM-authored draft only; no system-rule inference or dice evaluation. */
export function insertInitiativeAttribute(draft: string, path: string,
    selection?: { start: number; end: number } | null): { value: string; cursor: number } {
    if (!isSafeCombatStatPath(path)) throw new Error('Choose a safe numeric Actor attribute');
    const start = Math.max(0, Math.min(draft.length, selection?.start ?? draft.length));
    const end = Math.max(start, Math.min(draft.length, selection?.end ?? start));
    const left = draft.slice(0, start), right = draft.slice(end);
    const before = left.trim() && !/[+-]\s*$/.test(left) ? ' + ' : '';
    const after = right.trim() && !/^\s*[+-]/.test(right) ? ' + ' : '';
    const token = `${before}@${path}`;
    const value = `${left}${token}${after}${right}`;
    if (value.length > 160) throw new Error('Formula exceeds 160 characters; shorten it before inserting an attribute');
    return { value, cursor: left.length + token.length };
}
