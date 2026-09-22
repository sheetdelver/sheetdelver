export const diceStyles = [
    { id: 'teal', label: 'Teal', background: '#167c79', foreground: '#ffffff', outline: '#153d3b', edge: '#12615e', texture: 'none' },
    { id: 'crimson', label: 'Crimson', background: '#a72b43', foreground: '#ffffff', outline: '#45111c', edge: '#7d2032', texture: 'none' },
    { id: 'white', label: 'White', background: '#f4f6f8', foreground: '#182026', outline: 'none', edge: '#d1d9de', texture: 'none' },
    { id: 'onyx', label: 'Onyx', background: '#25272b', foreground: '#f3ca74', outline: '#121316', edge: '#17191c', texture: 'none' },
    { id: 'marble', label: 'Marble', background: '#cad9e5', foreground: '#151b20', outline: 'none', edge: '#d8e1e7', texture: 'marble' },
    { id: 'cobalt', label: 'Cobalt', background: '#2455a4', foreground: '#ffffff', outline: 'none', edge: '#183970', texture: 'none' },
    { id: 'emerald', label: 'Emerald', background: '#236347', foreground: '#ffffff', outline: 'none', edge: '#17432f', texture: 'none' },
    { id: 'plum', label: 'Plum', background: '#673c78', foreground: '#ffffff', outline: 'none', edge: '#44274f', texture: 'none' },
    { id: 'rose', label: 'Rose', background: '#f0a9bc', foreground: '#25202b', outline: 'none', edge: '#c37b91', texture: 'none' },
    { id: 'amber', label: 'Amber', background: '#efc45b', foreground: '#25202b', outline: 'none', edge: '#b48c32', texture: 'none' },
    { id: 'ice', label: 'Ice', background: '#a7dce8', foreground: '#172a35', outline: 'none', edge: '#75aab9', texture: 'none' },
] as const;

export const dicePalettes = [
    { id: 'festival', label: 'Festival', bodies: ['#167c79', '#a72b43', '#2359a2', '#6c3e94'], labelColor: '#ffffff', edge: '#172127' },
    { id: 'citrus', label: 'Citrus', bodies: ['#f4ce54', '#b8db62', '#f09ba9', '#80cddd'], labelColor: '#182026', edge: '#33434b' },
    { id: 'tidal', label: 'Tidal', bodies: ['#20566b', '#28657a', '#2a6860', '#364e86'], labelColor: '#ffffff', edge: '#172b35' },
    { id: 'twilight', label: 'Twilight', bodies: ['#343f78', '#654078', '#903d69', '#3d6771'], labelColor: '#ffffff', edge: '#272237' },
    { id: 'meadow', label: 'Meadow', bodies: ['#bddc96', '#f0c88f', '#dbb1d5', '#a8d9be'], labelColor: '#222b25', edge: '#48584d' },
    { id: 'glacier', label: 'Glacier', bodies: ['#dbeef3', '#a9cedf', '#c0c7e9', '#a7d8cf'], labelColor: '#182d3b', edge: '#526d7c' },
    { id: 'ember', label: 'Ember', bodies: ['#842d3c', '#944021', '#72451f', '#5e334f'], labelColor: '#ffffff', edge: '#38232a' },
    { id: 'monochrome', label: 'Monochrome', bodies: ['#f3f4f5', '#d4d9dd', '#b7c1ca', '#a0abb6'], labelColor: '#182026', edge: '#48525b' },
] as const;

export const diceTextures = ['auto', 'none', 'marble', 'wood', 'metal', 'speckles', 'stars'] as const;
export const diceMaterials = ['plastic', 'wood', 'metal'] as const;
export type DiceMaterial = typeof diceMaterials[number];

export interface DiceAppearance {
    style: typeof diceStyles[number]['id'] | typeof dicePalettes[number]['id'] | 'custom';
    size: number;
    custom?: DiceColors;
    texture?: typeof diceTextures[number];
    material?: DiceMaterial;
}

export interface DiceColors { body: string; label: string; outline: string | null; edge: string }

export function presetColors(style: DiceAppearance['style']): DiceColors {
    const palette = dicePalettes.find(value => value.id === style);
    if (palette) return { body: palette.bodies[0], label: palette.labelColor, edge: palette.edge, outline: null };
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
        style: data.style === 'custom' ? 'custom' : diceStyles.find(style => style.id === data.style)?.id
            ?? dicePalettes.find(style => style.id === data.style)?.id ?? defaultDiceAppearance.style,
        size: typeof data.size === 'number' && Number.isFinite(data.size)
            ? Math.max(75, Math.min(150, Math.round(data.size / 5) * 5)) : defaultDiceAppearance.size,
        ...(data.custom !== undefined || data.style === 'custom' ? { custom: normalizeColors(data.custom) } : {}),
        ...(diceTextures.includes(data.texture!) && data.texture !== 'auto' ? { texture: data.texture } : {}),
        ...(diceMaterials.includes(data.material!) && data.material !== 'plastic' ? { material: data.material } : {}),
    };
}

export function diceAppearanceOptions(value: DiceAppearance, viewportWidth: number, viewportHeight = viewportWidth, physicalDiceCount = 1) {
    const appearance = normalizeDiceAppearance(value);
    const palette = dicePalettes.find(style => style.id === appearance.style);
    const colors = appearance.custom ?? presetColors('teal');
    const style = appearance.style === 'custom' ? {
        label: 'Custom', foreground: colors.label, background: colors.body,
        outline: colors.outline ?? 'none', edge: colors.edge, texture: 'none',
    } : diceStyles.find(style => style.id === appearance.style) ?? diceStyles[0];
    return {
        assetPath: '/dice/',
        light_intensity: appearance.material === 'metal' ? 1.75 : 0.7,
        baseScale: (viewportWidth < 600 ? 65 : 90) * appearance.size / 100
            * Math.min(1, viewportWidth / 300, viewportHeight / Math.min(viewportWidth, 600))
            * Math.min(1, Math.sqrt(8 / Math.max(1, physicalDiceCount))),
        theme_customColorset: {
            name: `SheetDelver ${palette?.label ?? style.label}`,
            foreground: palette ? palette.bodies.map(() => palette.labelColor) : style.foreground,
            background: palette ? [...palette.bodies] : style.background,
            outline: palette ? palette.bodies.map(() => 'none') : style.outline,
            edge: palette ? palette.bodies.map(() => palette.edge) : style.edge,
            texture: appearance.texture ?? (palette ? 'none' : style.texture),
            material: appearance.material ?? 'plastic',
        },
    };
}
