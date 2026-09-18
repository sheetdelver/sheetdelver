'use client';

import type { CSSProperties } from 'react';
import { RotateCcw } from 'lucide-react';
import { useDicePresentation } from '../../context/DicePresentationContext';
import { DiceAppearanceControls } from './DiceAppearanceControls';
import { DiceSoundControls } from './DiceSoundControls';

const sectionStyle: CSSProperties = { border: 0, borderTop: '1px solid #46494d', padding: '16px 0 0', margin: '16px 0 0', minWidth: 0 };
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 14 };
const buttonStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 40, borderRadius: 6, padding: '8px 12px', background: '#303438', color: '#f2f4f5', border: '1px solid #666b70', cursor: 'pointer', font: 'inherit' };


export function DiceSettingsPanel() {
    const { enabled, setEnabled, appearance, setAppearance, sound, setSound, behavior, setBehavior, resetSettings } = useDicePresentation();
    return <div>
        <label style={rowStyle}><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />3D dice</label>
        <section aria-label="Appearance" style={sectionStyle}>
            <h3 style={{ fontSize: 16, margin: '0 0 12px' }}>Appearance</h3>
            <DiceAppearanceControls value={appearance} onChange={setAppearance} />
            <label style={rowStyle}><input type="checkbox" checked={behavior.lowEffects}
                onChange={event => setBehavior({ ...behavior, lowEffects: event.target.checked })} />Low effects (no shadows)</label>
        </section>
        <section aria-label="Sound" style={sectionStyle}>
            <h3 style={{ fontSize: 16, margin: '0 0 12px' }}>Sound</h3>
            <DiceSoundControls value={sound} onChange={setSound} />
            <label style={rowStyle}><input type="checkbox" checked={behavior.mutePrivateRolls}
                onChange={event => setBehavior({ ...behavior, mutePrivateRolls: event.target.checked })} />Mute private-roll sounds</label>
        </section>
        <section aria-label="Behavior" style={sectionStyle}>
            <h3 style={{ fontSize: 16, margin: 0 }}>Behavior</h3>
            <label style={rowStyle}><input type="checkbox" checked={behavior.ownRollsOnly}
                onChange={event => setBehavior({ ...behavior, ownRollsOnly: event.target.checked })} />Only my rolls</label>
            <label style={{ ...rowStyle, flexWrap: 'wrap' }}>Display duration
                <input type="range" aria-label="Display duration" min={500} max={5000} step={100}
                    style={{ width: 100, maxWidth: '100%' }} value={behavior.displayDurationMs}
                    onChange={event => setBehavior({ ...behavior, displayDurationMs: Number(event.target.value) })} />
                <output style={{ minWidth: 40, fontVariantNumeric: 'tabular-nums' }}>{(behavior.displayDurationMs / 1000).toFixed(1)}s</output>
            </label>
        </section>

        <button type="button" style={{ ...buttonStyle, marginTop: 20 }} onClick={resetSettings}>
            <RotateCcw size={16} aria-hidden="true" />Reset dice
        </button>
    </div>;
}
