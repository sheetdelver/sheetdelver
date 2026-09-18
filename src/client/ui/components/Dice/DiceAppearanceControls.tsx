'use client';

import { Check } from 'lucide-react';
import { diceStyles, type DiceAppearance } from './appearance';

export function DiceAppearanceControls({ value, onChange, disabled = false }: {
    value: DiceAppearance;
    onChange: (value: DiceAppearance) => void;
    disabled?: boolean;
}) {
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
            </div>
        </fieldset>
        <label className="flex items-center gap-2" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            Dice size
            <input type="range" aria-label="Dice size" min={75} max={150} step={5}
                style={{ width: 100, maxWidth: '100%' }} value={value.size} disabled={disabled}
                onChange={event => onChange({ ...value, size: Number(event.target.value) })} />
            <output style={{ width: 40, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{value.size}%</output>
        </label>
    </div>;
}
