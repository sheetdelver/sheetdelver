'use client';

import { Check, Palette } from 'lucide-react';
import { diceStyles, presetColors, diceColorContrast, type DiceAppearance } from './appearance';

export function DiceAppearanceControls({ value, onChange, disabled = false }: {
    value: DiceAppearance;
    onChange: (value: DiceAppearance) => void;
    disabled?: boolean;
}) {
    const colors = value.custom ?? presetColors(value.style);
    return <div className="flex flex-col gap-2 text-sm text-white/70">
        <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <legend className="mb-2">Dice style</legend>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {diceStyles.map(style => <button key={style.id} type="button"
                    aria-label={`${style.label} dice`} aria-pressed={value.style === style.id}
                    title={style.label} onClick={() => onChange({ ...value, style: style.id })}
                    style={{ width: 40, height: 40, padding: 0, display: 'grid', placeItems: 'center',
                        borderRadius: 6, border: `2px solid ${value.style === style.id ? '#ffffff' : '#62696f'}`,
                        backgroundColor: style.background, color: style.foreground,
                        backgroundImage: style.texture === 'marble' ? 'url(/dice/textures/marble.webp)' : undefined,
                        backgroundSize: 'cover', opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer',
                    }}>
                    {value.style === style.id && <Check size={20} aria-hidden="true" />}
                </button>)}
                <button type="button" title="Custom colors" aria-label="Custom colors" aria-pressed={value.style === 'custom'}
                    onClick={() => onChange({ ...value, style: 'custom', custom: colors })}
                    style={{ width: 40, height: 40, display: 'grid', placeItems: 'center', borderRadius: 6,
                        border: `2px solid ${value.style === 'custom' ? '#ffffff' : '#62696f'}`, background: colors.body, color: colors.label }}>
                    <Palette size={20} aria-hidden="true" />
                </button>
            </div>
        </fieldset>
        {value.style === 'custom' && <fieldset disabled={disabled} style={{ border: 0, padding: '8px 0', margin: 0, minWidth: 0 }}>
            <legend>Custom colors</legend>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                {(['body', 'label', 'edge', 'outline'] as const).map(key => <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <input type="color" aria-label={`Dice ${key} color`} value={colors[key] ?? '#000000'}
                        disabled={key === 'outline' && colors.outline === null} style={{ width: 36, height: 32, flexShrink: 0 }}
                        onChange={event => onChange({ ...value, custom: { ...colors, [key]: event.target.value } })} />
                    {key[0].toUpperCase() + key.slice(1)}
                </label>)}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
                <input type="checkbox" checked={colors.outline !== null}
                    onChange={event => onChange({ ...value, custom: { ...colors, outline: event.target.checked ? '#000000' : null } })} />Label outline
            </label>
            {diceColorContrast(colors) < 3 && <p role="status" style={{ color: '#f3ca74', margin: '8px 0 0' }}>Low label contrast</p>}
        </fieldset>}
        <label className="flex items-center gap-2" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            Dice size
            <input type="range" aria-label="Dice size" min={75} max={150} step={5}
                style={{ width: 100, maxWidth: '100%' }} value={value.size} disabled={disabled}
                onChange={event => onChange({ ...value, size: Number(event.target.value) })} />
            <output style={{ width: 40, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{value.size}%</output>
        </label>
    </div>;
}
