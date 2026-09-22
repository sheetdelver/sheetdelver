'use client';

import type { CSSProperties } from 'react';
import { Dices, RotateCcw, Square } from 'lucide-react';
import { useDicePresentation } from '../../context/DicePresentationContext';
import { DiceAppearanceControls } from './DiceAppearanceControls';
import { DiceSoundControls } from './DiceSoundControls';
import { diceRegions, type DiceRegion } from './viewport';
import type { DiceBehavior } from './behavior';

const sectionStyle: CSSProperties = { border: 0, borderTop: '1px solid #46494d', padding: '16px 0 0', margin: '16px 0 0', minWidth: 0 };
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 14 };
const buttonStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 40, borderRadius: 6, padding: '8px 12px', background: '#303438', color: '#f2f4f5', border: '1px solid #666b70', cursor: 'pointer', font: 'inherit' };
const selectStyle: CSSProperties = { background: '#303438', color: '#f2f4f5', padding: '6px 8px', borderRadius: 4, minWidth: 0, maxWidth: '100%' };


export function DiceSettingsPanel() {
    const { enabled, setEnabled, appearance, setAppearance, sound, setSound, behavior, setBehavior, resetSettings,
        canTest, testing, testDice, cancelTest } = useDicePresentation();
    return <div>
        <label style={rowStyle}><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />3D dice</label>
        <section aria-label="Appearance" style={sectionStyle}>
            <h3 style={{ fontSize: 16, margin: '0 0 12px' }}>Appearance</h3>
            <DiceAppearanceControls value={appearance} onChange={setAppearance} />
        </section>
        <section aria-label="Rendering" style={sectionStyle}>
            <h3 style={{ fontSize: 16, margin: 0 }}>Rendering</h3>
            <label style={rowStyle}>Shadows
                <select aria-label="Dice shadows" style={selectStyle} value={behavior.lowEffects ? 'none' : behavior.shadowQuality ?? 'standard'}
                    onChange={event => setBehavior({ ...behavior, lowEffects: event.target.value === 'none',
                        shadowQuality: event.target.value === 'low' ? 'low' : 'standard' })}>
                    <option value="none">None</option><option value="low">Low</option><option value="standard">Standard</option>
                </select>
            </label>
            <label style={rowStyle}><input type="checkbox" checked={behavior.engravedLabels !== false}
                onChange={event => setBehavior({ ...behavior, engravedLabels: event.target.checked })} />Engraved labels</label>
            <label style={rowStyle}><input type="checkbox" checked={behavior.highDpi === true}
                onChange={event => setBehavior({ ...behavior, highDpi: event.target.checked })} />High resolution</label>
        </section>
        <section aria-label="Sound" style={sectionStyle}>
            <h3 style={{ fontSize: 16, margin: '0 0 12px' }}>Sound</h3>
            <DiceSoundControls value={sound} onChange={setSound} />
            <label style={rowStyle}><input type="checkbox" checked={behavior.mutePrivateRolls}
                onChange={event => setBehavior({ ...behavior, mutePrivateRolls: event.target.checked })} />Mute private-roll sounds</label>
        </section>
        <section aria-label="Behavior" style={sectionStyle}>
            <h3 style={{ fontSize: 16, margin: 0 }}>Behavior</h3>
            <label style={rowStyle}>Throwing force
                <select aria-label="Dice throwing force" style={selectStyle} value={behavior.throwForce ?? 'normal'}
                    onChange={event => setBehavior({ ...behavior, throwForce: event.target.value as DiceBehavior['throwForce'] })}>
                    <option value="soft">Soft</option><option value="normal">Normal</option><option value="strong">Strong</option>
                </select>
            </label>
            <label style={rowStyle}>Rolling region
                <select aria-label="Dice rolling region" style={selectStyle} value={behavior.region ?? 'full'}
                    onChange={event => setBehavior({ ...behavior, region: event.target.value as DiceRegion })}>
                    {Object.entries(diceRegions).map(([id, region]) => <option key={id} value={id}>{region.label}</option>)}
                </select>
            </label>
            <label style={rowStyle}><input type="checkbox" checked={behavior.showResultsImmediately}
                onChange={event => setBehavior({ ...behavior, showResultsImmediately: event.target.checked })} />Show results immediately</label>
            <label style={rowStyle}><input type="checkbox" checked={behavior.ownRollsOnly}
                onChange={event => setBehavior({ ...behavior, ownRollsOnly: event.target.checked })} />Only my rolls</label>
            <label style={{ ...rowStyle, flexWrap: 'wrap' }}>Settlement effect
                <select aria-label="Dice settlement effect" style={selectStyle} value={behavior.settlementEffect ?? 'none'}
                    onChange={event => setBehavior({ ...behavior, settlementEffect: event.target.value as DiceBehavior['settlementEffect'] })}>
                    <option value="none">None</option><option value="highlight">Highlight</option>
                    <option value="breathing">Breathing</option><option value="crescendo">Crescendo</option>
                </select>
            </label>
            <label style={{ ...rowStyle, flexWrap: 'wrap' }}>Display duration
                <input type="range" aria-label="Display duration" min={500} max={5000} step={100}
                    style={{ width: 100, maxWidth: '100%' }} value={behavior.displayDurationMs}
                    onChange={event => setBehavior({ ...behavior, displayDurationMs: Number(event.target.value) })} />
                <output style={{ minWidth: 40, fontVariantNumeric: 'tabular-nums' }}>{(behavior.displayDurationMs / 1000).toFixed(1)}s</output>
            </label>
            <label style={rowStyle}>Hide effect
                <select aria-label="Dice hide effect" value={behavior.hideEffect}
                    style={{ background: '#303438', color: '#f2f4f5', padding: '6px 8px', borderRadius: 4 }}
                    onChange={event => setBehavior({ ...behavior, hideEffect: event.target.value === 'fade' ? 'fade' : 'none' })}>
                    <option value="none">None</option><option value="fade">Fade</option>
                </select>
            </label>
        </section>

        <button type="button" title={testing ? 'Stop test dice' : 'Test dice'} disabled={!canTest && !testing}
            style={{ ...buttonStyle, marginTop: 20, marginRight: 8, opacity: canTest || testing ? 1 : 0.5 }} onClick={testing ? cancelTest : testDice}>
            {testing ? <Square size={16} aria-hidden="true" /> : <Dices size={16} aria-hidden="true" />}{testing ? 'Stop test' : 'Test dice'}
        </button>
        <button type="button" style={{ ...buttonStyle, marginTop: 20 }} onClick={resetSettings}>
            <RotateCcw size={16} aria-hidden="true" />Reset dice
        </button>
    </div>;
}
