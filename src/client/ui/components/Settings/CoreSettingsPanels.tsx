import { useId } from 'react';
import { useChat } from '../../context/ChatContext';
import { DiceSettingsPanel } from '../Dice/DiceSettingsPanel';
import { usePlayerAppearance, type PlayerAppearance } from '../../context/PlayerAppearanceContext';

export const CORE_SETTINGS_TABS = [
    { key: 'general', label: 'General', disabled: true },
    { key: 'chat', label: 'Chat & Rolls' },
    { key: 'themes', label: 'Themes' },
];

export function ChatSettingsPanel() {
    const { toastSettings, setToastSettings } = useChat();
    return <>
        <section aria-label="Chat notifications" className="border-b sd-ui-divider" style={{ paddingBottom: 20, marginBottom: 20 }}>
            <h3 style={{ fontSize: 16, margin: '0 0 12px' }}>Chat</h3>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                <input type="checkbox" checked={toastSettings.enabled} onChange={event => setToastSettings({ ...toastSettings, enabled: event.target.checked })} />Chat previews
            </label>
            <label style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 12, fontSize: 14 }}>
                Preview duration
                <input type="range" aria-label="Preview duration" min={1000} max={15000} step={500}
                    style={{ width: 100, maxWidth: '100%' }} value={toastSettings.durationMs} disabled={!toastSettings.enabled}
                    onChange={event => setToastSettings({ ...toastSettings, durationMs: Number(event.target.value) })} />
                <output style={{ minWidth: 44, fontVariantNumeric: 'tabular-nums' }}>{(toastSettings.durationMs / 1000).toFixed(1)}s</output>
            </label>
        </section>
        <DiceSettingsPanel />
    </>;
}

export function ThemeSettingsPanel() {
    const { appearance, setAppearance } = usePlayerAppearance();
    const id = useId();
    return <>
        <h3 className="font-semibold text-lg mb-2">Appearance</h3>
        <p className="sd-ui-muted text-sm mb-5">Choose the appearance of SheetDelver controls. System sheets keep their own theme.</p>
        <div className="grid gap-3">
            {(['dark', 'light'] as PlayerAppearance[]).map(option => <label key={option}
                className="sd-ui-panel flex items-center gap-3 rounded-lg p-4 cursor-pointer">
                <input type="radio" name={`${id}-appearance`} checked={appearance === option}
                    onChange={() => setAppearance(option)} />
                <span className="font-medium capitalize">{option}</span>
            </label>)}
        </div>
        <p className="sd-ui-muted text-xs mt-5">Saved in this browser for this site.</p>
    </>;
}
