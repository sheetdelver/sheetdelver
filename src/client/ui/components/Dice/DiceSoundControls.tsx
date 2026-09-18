'use client';

import { Volume2 } from 'lucide-react';
import type { DiceSoundSettings } from './collisionAudio';

export function DiceSoundControls({ value, onChange, disabled = false }: {
    value: DiceSoundSettings;
    onChange: (value: DiceSoundSettings) => void;
    disabled?: boolean;
}) {
    return <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-white/70">
        <label className="flex items-center gap-2">
            <input type="checkbox" checked={value.enabled} disabled={disabled}
                onChange={event => onChange({ ...value, enabled: event.target.checked })} />
            Dice sounds
        </label>
        <label className="flex min-w-0 items-center gap-2" title="Dice volume">
            <Volume2 size={16} aria-hidden="true" />
            <input type="range" aria-label="Dice volume" min={0} max={100} step={5}
                style={{ width: 100, maxWidth: '100%' }} value={value.volume}
                disabled={disabled || !value.enabled}
                onChange={event => onChange({ ...value, volume: Number(event.target.value) })} />
            <output style={{ width: 40, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{value.volume}%</output>
        </label>
    </div>;
}
