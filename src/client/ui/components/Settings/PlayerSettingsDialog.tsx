'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useUI } from '../../context/UIContext';
import { useSession } from '../../context/SessionContext';
import { useFoundry } from '../../context/FoundryContext';
import { useChat } from '../../context/ChatContext';
import { DiceSettingsPanel } from '../Dice/DiceSettingsPanel';
import { usePlayerAppearance, type PlayerAppearance } from '../../context/PlayerAppearanceContext';

export function PlayerSettingsDialog() {
    const { isSettingsOpen, setSettingsOpen } = useUI();
    const { token, step } = useSession();
    const { worldId } = useFoundry();
    useEffect(() => { setSettingsOpen(false); }, [token, step, worldId, setSettingsOpen]);
    if (!isSettingsOpen || !token || step !== 'dashboard') return null;
    return <SettingsDialog onClose={() => setSettingsOpen(false)} />;
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
    const { toastSettings, setToastSettings } = useChat();
    const { appearance, setAppearance } = usePlayerAppearance();
    const [activeTab, setActiveTab] = useState<'chat' | 'themes'>('chat');
    const dialogRef = useRef<HTMLDialogElement>(null);
    const id = useId();
    useEffect(() => {
        const dialog = dialogRef.current!;
        const previousFocus = document.activeElement;
        const overflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        dialog.showModal();
        return () => {
            dialog.close();
            document.body.style.overflow = overflow;
            if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        };
    }, []);

    return createPortal(<dialog ref={dialogRef} aria-labelledby={`${id}-title`} className="sd-ui-modal sd-ui-panel-raised backdrop:bg-black/70"
        onCancel={event => { event.preventDefault(); onClose(); }}
        onKeyDown={event => {
            if (event.key !== 'Tab') return;
            const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'
            ));
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
        style={{ width: 'min(520px, calc(100vw - 24px))', height: 'min(740px, calc(100dvh - 32px))',
            maxHeight: 'calc(100dvh - 32px)', margin: 'auto', padding: 0, borderRadius: 8, letterSpacing: 0 }}>
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', gap: 12 }}>
                <h2 id={`${id}-title`} style={{ fontSize: 20, margin: 0 }}>Settings</h2>
                <button type="button" title="Close settings" aria-label="Close settings" onClick={onClose}
                    className="sd-ui-button" style={{ width: 40, height: 40, flexShrink: 0, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><X size={20} aria-hidden="true" /></button>
            </header>
            <div role="tablist" aria-label="Settings sections" className="border-b sd-ui-divider" style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr 1fr', padding: '0 12px' }}>
                {(['General', 'Chat & Rolls', 'Themes'] as const).map((label, index) => <button key={label}
                    type="button" role="tab" id={`${id}-tab-${index}`} aria-selected={index === 1 ? activeTab === 'chat' : index === 2 && activeTab === 'themes'}
                    aria-controls={index === 1 ? `${id}-chat` : index === 2 ? `${id}-themes` : undefined}
                    disabled={index === 0} onClick={() => setActiveTab(index === 2 ? 'themes' : 'chat')}
                    className={index === 0 ? 'sd-ui-muted opacity-50' : (index === 1 && activeTab === 'chat') || (index === 2 && activeTab === 'themes') ? 'sd-ui-accent' : 'sd-ui-muted'}
                    style={{ fontSize: 14, minHeight: 44, padding: '8px 4px',
                        borderBottom: ((index === 1 && activeTab === 'chat') || (index === 2 && activeTab === 'themes')) ? '2px solid var(--sd-ui-accent)' : '2px solid transparent' }}>
                    {label}
                </button>)}
            </div>
            {activeTab === 'chat' ? <div role="tabpanel" id={`${id}-chat`} aria-labelledby={`${id}-tab-1`} tabIndex={0}
                style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px' }}>
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
            </div> : <div role="tabpanel" id={`${id}-themes`} aria-labelledby={`${id}-tab-2`} tabIndex={0}
                style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px' }}>
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
            </div>}
            <footer className="border-t sd-ui-divider" style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 20px' }}>
                <button type="button" onClick={onClose} className="sd-ui-button" style={{ minHeight: 40, padding: '8px 16px', cursor: 'pointer', fontSize: 14 }}>Done</button>
            </footer>
        </div>
    </dialog>, document.body);
}
