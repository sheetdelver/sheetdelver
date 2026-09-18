export const diceStyles = [
    { id: 'teal', label: 'Teal', background: '#167c79', foreground: '#ffffff', outline: '#153d3b', edge: '#12615e', texture: 'none' },
    { id: 'crimson', label: 'Crimson', background: '#a72b43', foreground: '#ffffff', outline: '#45111c', edge: '#7d2032', texture: 'none' },
    { id: 'white', label: 'White', background: '#f4f6f8', foreground: '#182026', outline: 'none', edge: '#d1d9de', texture: 'none' },
    { id: 'onyx', label: 'Onyx', background: '#25272b', foreground: '#f3ca74', outline: '#121316', edge: '#17191c', texture: 'none' },
    { id: 'marble', label: 'Marble', background: '#cad9e5', foreground: '#151b20', outline: 'none', edge: '#d8e1e7', texture: 'marble' },
] as const;

export interface DiceAppearance {
    style: typeof diceStyles[number]['id'];
    size: number;
}

export const defaultDiceAppearance: DiceAppearance = { style: 'teal', size: 100 };

export function normalizeDiceAppearance(value: unknown): DiceAppearance {
    const data = value && typeof value === 'object' ? value as Partial<DiceAppearance> : {};
    return {
        style: diceStyles.find(style => style.id === data.style)?.id ?? defaultDiceAppearance.style,
        size: typeof data.size === 'number' && Number.isFinite(data.size)
            ? Math.max(75, Math.min(150, Math.round(data.size / 5) * 5)) : defaultDiceAppearance.size,
    };
}

export function diceAppearanceOptions(value: DiceAppearance, viewportWidth: number) {
    const appearance = normalizeDiceAppearance(value);
    const style = diceStyles.find(style => style.id === appearance.style)!;
    return {
        assetPath: '/dice/',
        baseScale: (viewportWidth < 600 ? 65 : 90) * appearance.size / 100,
        theme_customColorset: {
            name: `SheetDelver ${style.label}`, foreground: style.foreground,
            background: style.background, outline: style.outline, edge: style.edge,
            texture: style.texture, material: 'plastic',
        },
    };
}
