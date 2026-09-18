'use client';

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useUI } from '../../context/UIContext';
import { useSession } from '../../context/SessionContext';
import { useFoundry } from '../../context/FoundryContext';
import { useChat } from '../../context/ChatContext';
import { DiceSettingsPanel } from '../Dice/DiceSettingsPanel';

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

    return createPortal(<dialog ref={dialogRef} aria-labelledby={`${id}-title`} className="hud-panel backdrop:bg-black/70"
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
            maxHeight: 'calc(100dvh - 32px)', margin: 'auto', padding: 0, borderRadius: 8,
            border: '1px solid #62686d', background: '#202326', color: '#f2f4f5', letterSpacing: 0 }}>
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', gap: 12 }}>
                <h2 id={`${id}-title`} style={{ fontSize: 20, margin: 0 }}>Settings</h2>
                <button type="button" title="Close settings" aria-label="Close settings" onClick={onClose}
                    style={{ width: 40, height: 40, flexShrink: 0, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><X size={20} aria-hidden="true" /></button>
            </header>
            <div role="tablist" aria-label="Settings sections" style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr 1fr', borderBottom: '1px solid #46494d', padding: '0 12px' }}>
                {['General', 'Chat & Rolls', 'Themes'].map((label, index) => <button key={label}
                    type="button" role="tab" id={`${id}-tab-${index}`} aria-selected={index === 1}
                    aria-controls={index === 1 ? `${id}-chat` : undefined} disabled={index !== 1}
                    style={{ fontSize: 14, minHeight: 44, padding: '8px 4px', color: index === 1 ? '#f3ca74' : '#939b9f',
                        opacity: index === 1 ? 1 : 0.55, borderBottom: index === 1 ? '2px solid #f3ca74' : '2px solid transparent' }}>
                    {label}
                </button>)}
            </div>
            <div role="tabpanel" id={`${id}-chat`} aria-labelledby={`${id}-tab-1`} tabIndex={0}
                style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px' }}>
                <section aria-label="Chat notifications" style={{ borderBottom: '1px solid #46494d', paddingBottom: 20, marginBottom: 20 }}>
                    <h3 style={{ fontSize: 16, margin: '0 0 12px' }}>Chat</h3>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                        <input type="checkbox" checked={toastSettings.enabled} onChange={event => setToastSettings({ ...toastSettings, enabled: event.target.checked })} />Chat toasts
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 12, fontSize: 14 }}>
                        Toast duration
                        <input type="range" aria-label="Toast duration" min={1000} max={15000} step={500}
                            style={{ width: 100, maxWidth: '100%' }} value={toastSettings.durationMs} disabled={!toastSettings.enabled}
                            onChange={event => setToastSettings({ ...toastSettings, durationMs: Number(event.target.value) })} />
                        <output style={{ minWidth: 44, fontVariantNumeric: 'tabular-nums' }}>{(toastSettings.durationMs / 1000).toFixed(1)}s</output>
                    </label>
                </section>
                <DiceSettingsPanel />
            </div>
            <footer style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 20px', borderTop: '1px solid #46494d' }}>
                <button type="button" onClick={onClose} style={{ minHeight: 40, padding: '8px 16px', borderRadius: 6,
                    border: '1px solid #666b70', background: '#303438', cursor: 'pointer', fontSize: 14 }}>Done</button>
            </footer>
        </div>
    </dialog>, document.body);
}
