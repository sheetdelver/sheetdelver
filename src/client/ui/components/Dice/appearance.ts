export const diceStyles = [
    { id: 'teal', label: 'Teal', background: '#167c79', foreground: '#ffffff', outline: '#153d3b', edge: '#12615e', texture: 'none' },
    { id: 'crimson', label: 'Crimson', background: '#a72b43', foreground: '#ffffff', outline: '#45111c', edge: '#7d2032', texture: 'none' },
    { id: 'white', label: 'White', background: '#f4f6f8', foreground: '#182026', outline: 'none', edge: '#d1d9de', texture: 'none' },
    { id: 'onyx', label: 'Onyx', background: '#25272b', foreground: '#f3ca74', outline: '#121316', edge: '#17191c', texture: 'none' },
    { id: 'marble', label: 'Marble', background: '#cad9e5', foreground: '#151b20', outline: 'none', edge: '#d8e1e7', texture: 'marble' },
] as const;

export interface DiceAppearance {
    style: typeof diceStyles[number]['id'] | 'custom';
    size: number;
    custom?: DiceColors;
}

export interface DiceColors { body: string; label: string; outline: string | null; edge: string }

export function presetColors(style: DiceAppearance['style']): DiceColors {
    const preset = diceStyles.find(value => value.id === style) ?? diceStyles[0];
    return { body: preset.background, label: preset.foreground, edge: preset.edge,
        outline: preset.outline === 'none' ? null : preset.outline };
}

function normalizeColors(value: unknown): DiceColors {
    const colors = value && typeof value === 'object' ? value as Partial<DiceColors> : {};
    const defaults = presetColors('teal');
    const hex = (value: unknown, fallback: string) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
    return { body: hex(colors.body, defaults.body), label: hex(colors.label, defaults.label),
        edge: hex(colors.edge, defaults.edge), outline: colors.outline === null ? null : hex(colors.outline, defaults.outline!) };
}

export function diceColorContrast(colors: DiceColors): number {
    const luminance = (hex: string) => {
        const rgb = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255)
            .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const a = luminance(colors.body), b = luminance(colors.label);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export const defaultDiceAppearance: DiceAppearance = { style: 'teal', size: 100 };

export function normalizeDiceAppearance(value: unknown): DiceAppearance {
    const data = value && typeof value === 'object' ? value as Partial<DiceAppearance> : {};
    return {
        style: data.style === 'custom' ? 'custom' : diceStyles.find(style => style.id === data.style)?.id ?? defaultDiceAppearance.style,
        size: typeof data.size === 'number' && Number.isFinite(data.size)
            ? Math.max(75, Math.min(150, Math.round(data.size / 5) * 5)) : defaultDiceAppearance.size,
        ...(data.custom !== undefined || data.style === 'custom' ? { custom: normalizeColors(data.custom) } : {}),
    };
}

export function diceAppearanceOptions(value: DiceAppearance, viewportWidth: number) {
    const appearance = normalizeDiceAppearance(value);
    const colors = appearance.custom ?? presetColors('teal');
    const style = appearance.style === 'custom' ? {
        label: 'Custom', foreground: colors.label, background: colors.body,
        outline: colors.outline ?? 'none', edge: colors.edge, texture: 'none',
    } : diceStyles.find(style => style.id === appearance.style)!;
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
