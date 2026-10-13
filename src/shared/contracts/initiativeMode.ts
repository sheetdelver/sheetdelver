/** Bounded leading-d20 override shared by execution and its dialog preview. */
export function applyInitiativeMode(formula: string, mode?: 'normal' | 'advantage' | 'disadvantage'): string {
    if (!mode) return formula;
    const replacement = mode === 'advantage' ? '2d20kh1'
        : mode === 'disadvantage' ? '2d20kl1' : '1d20';
    const leading = mode === 'normal' ? /^(\s*)2d20k[hl]1(?!\d)/i
        : /^(\s*)(?:1d20|2d20k[hl]1)(?!\d)/i;
    return formula.replace(leading, (_full, whitespace: string) => whitespace + replacement);
}
