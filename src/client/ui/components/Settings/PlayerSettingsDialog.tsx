'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { getUIModule } from '@modules/registry/client';
import type { ModuleSettingsTab } from '@shared/sdk';
import { logger } from '@shared/utils/logger';
import { acquireBodyScrollLock } from '../../hooks/bodyScrollLock';
import { useUI } from '../../context/UIContext';
import { useSession } from '../../context/SessionContext';
import { useFoundry } from '../../context/FoundryContext';
import { ConfirmationModal } from '../ConfirmationModal';
import { ChatSettingsPanel, CORE_SETTINGS_TABS, ThemeSettingsPanel } from './CoreSettingsPanels';
import { eligibleSettingsTabs, resolveSettingsTabs } from './settingsTabs';
import { ModuleSettingsPanel, type SettingsPanelSession } from './ModuleSettingsPanel';
import { clearSettingsPanelCache } from './settingsPanelCache';

export function PlayerSettingsDialog() {
    const { isSettingsOpen, setSettingsOpen } = useUI();
    const { token, step, sessionEpoch, currentUser } = useSession();
    const { worldId, system, activeUIModule, appSocket } = useFoundry();
    const systemId = system?.id;
    const userId = currentUser?._id || currentUser?.id;
    useEffect(() => {
        clearSettingsPanelCache();
        setSettingsOpen(false);
    }, [token, step, sessionEpoch, userId, worldId, systemId, activeUIModule, setSettingsOpen]);
    useEffect(() => {
        if (!appSocket) return;
        const retire = ({ moduleId }: { moduleId?: string } = {}) => {
            if (!moduleId || moduleId.toLowerCase() === systemId?.toLowerCase()) {
                clearSettingsPanelCache();
                setSettingsOpen(false);
            }
        };
        const events = ['moduleSourceChanged', 'moduleStateChanged', 'moduleRegistryChanged'];
        events.forEach(event => appSocket.on(event, retire));
        return () => { events.forEach(event => appSocket.off(event, retire)); };
    }, [appSocket, systemId, setSettingsOpen]);
    if (!isSettingsOpen || !token || step !== 'dashboard') return null;
    return <SettingsDialog key={JSON.stringify([sessionEpoch, userId, worldId, systemId])}
        moduleId={systemId ?? null} worldId={worldId} role={currentUser?.role ?? 0} onClose={() => setSettingsOpen(false)} />;
}

type Navigation = { tab: string } | { close: true } | { retry: true };
interface Tab { key: string; label: string; disabled?: boolean; moduleTab?: ModuleSettingsTab }

function SettingsDialog({ moduleId, worldId, role, onClose }: {
    moduleId: string | null; worldId: string | null; role: number; onClose: () => void;
}) {
    const [contribution, setContribution] = useState<{ title: string; tabs: ModuleSettingsTab[] } | null>(null);
    const [activeTab, setActiveTab] = useState('chat');
    const [focusedTab, setFocusedTab] = useState('chat');
    const [retry, setRetry] = useState(0);
    const [pending, setPending] = useState<Navigation | null>(null);
    const sessionRef = useRef<SettingsPanelSession | null>(null);
    const registerSession = useCallback((session: SettingsPanelSession) => { sessionRef.current = session; }, []);
    const retirePanel = useCallback(() => {
        sessionRef.current?.controller.abort();
        sessionRef.current = null;
    }, []);
    const dialogRef = useRef<HTMLDialogElement>(null);
    const tablistRef = useRef<HTMLDivElement>(null);
    const id = useId();
    useEffect(() => {
        let retired = false;
        if (moduleId) void getUIModule(moduleId).then(manifest => {
            if (retired || !manifest) return;
            const resolved = resolveSettingsTabs(manifest);
            if (resolved.rejected) logger.warn(`[Settings] Rejected ${resolved.rejected} invalid settings tabs.`);
            setContribution({ title: String(manifest.info.title || moduleId).slice(0, 80), tabs: resolved.tabs });
        }).catch(() => { if (!retired) logger.warn('[Settings] Module settings registration could not be loaded.'); });
        return () => { retired = true; };
    }, [moduleId]);
    const moduleTabs = eligibleSettingsTabs(contribution?.tabs ?? [], role);
    const tabs: Tab[] = [...CORE_SETTINGS_TABS, ...moduleTabs.map(tab => ({ key: `module:${moduleId}:${tab.id}`, label: tab.label, moduleTab: tab }))];
    const selected = tabs.find(tab => tab.key === activeTab) ?? tabs[1];
    const focusKey = tabs.some(tab => !tab.disabled && tab.key === focusedTab) ? focusedTab : selected.key;

    useEffect(() => {
        if (activeTab === selected.key) return;
        // Forced eligibility loss discards drafts and any pending navigation.
        retirePanel(); setPending(null); setActiveTab('chat'); setFocusedTab('chat');
        tablistRef.current?.querySelector<HTMLButtonElement>('[data-tab-key="chat"]')?.focus();
    }, [activeTab, selected.key, retirePanel]);
    useEffect(() => {
        const dialog = dialogRef.current!;
        const previousFocus = document.activeElement;
        const releaseScrollLock = acquireBodyScrollLock();
        dialog.showModal();
        return () => {
            retirePanel(); dialog.close(); releaseScrollLock();
            if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        };
    }, [retirePanel]);

    const navigate = (action: Navigation) => {
        retirePanel(); setPending(null);
        if ('close' in action) onClose();
        else if ('retry' in action) setRetry(value => value + 1);
        else {
            setActiveTab(action.tab); setFocusedTab(action.tab);
            // Confirmation may have taken focus away from the requested tab.
            Array.from(tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
                .find(button => button.dataset.tabKey === action.tab)?.focus();
        }
    };
    const requestNavigation = (action: Navigation) => {
        if ('tab' in action && action.tab === selected.key) return;
        if (sessionRef.current?.dirty && !sessionRef.current.controller.signal.aborted) setPending(action);
        else navigate(action);
    };

    const tabButton = (tab: Tab) => <button key={tab.key} type="button" role="tab" data-tab-key={tab.key}
        id={`${id}-tab-${tab.key}`} aria-selected={selected.key === tab.key} aria-controls={`${id}-panel-${tab.key}`}
        tabIndex={!tab.disabled && focusKey === tab.key ? 0 : -1} disabled={tab.disabled}
        onFocus={() => setFocusedTab(tab.key)} onClick={() => requestNavigation({ tab: tab.key })}
        className={tab.disabled ? 'sd-ui-muted opacity-50' : selected.key === tab.key ? 'sd-ui-accent' : 'sd-ui-muted'}
        style={{ flexShrink: 0, flexGrow: 1, whiteSpace: 'nowrap', fontSize: 14, minHeight: 44, padding: '8px 12px',
            borderBottom: selected.key === tab.key ? '2px solid var(--sd-ui-accent)' : '2px solid transparent' }}>{tab.label}</button>;

    return createPortal(<dialog ref={dialogRef} aria-labelledby={`${id}-title`} className="sd-ui-modal sd-ui-panel-raised backdrop:bg-black/70"
        onCancel={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); requestNavigation({ close: true }); }}
        onKeyDown={event => {
            if (event.key !== 'Tab' || (event.target as HTMLElement).closest('dialog') !== event.currentTarget) return;
            const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]'
            )).filter(element => element.getClientRects().length > 0);
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
        style={{ width: 'min(520px, calc(100vw - 24px))', height: 'min(740px, calc(100dvh - 32px))',
            maxHeight: 'calc(100dvh - 32px)', margin: 'auto', padding: 0, borderRadius: 8, letterSpacing: 0 }}>
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
            <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', gap: 12 }}>
                <h2 id={`${id}-title`} style={{ fontSize: 20, margin: 0 }}>Settings</h2>
                <button type="button" title="Close settings" aria-label="Close settings" onClick={() => requestNavigation({ close: true })}
                    className="sd-ui-button" style={{ width: 40, height: 40, flexShrink: 0, display: 'grid', placeItems: 'center', cursor: 'pointer' }}><X size={20} aria-hidden="true" /></button>
            </header>
            <div ref={tablistRef} role="tablist" aria-label="Settings sections" className="border-b sd-ui-divider"
                style={{ display: 'flex', flexShrink: 0, alignItems: 'end', overflowX: 'auto', padding: '0 8px' }}
                onKeyDown={event => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    const enabled = tabs.filter(tab => !tab.disabled);
                    const index = enabled.findIndex(tab => tab.key === focusedTab);
                    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
                        : (index + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
                    event.preventDefault();
                    const button = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(button => button.dataset.tabKey === enabled[next].key);
                    button?.focus(); button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                }}>
                <div role="group" aria-label="SheetDelver" style={{ display: 'flex' }}>{tabs.filter(tab => !tab.moduleTab).map(tabButton)}</div>
                {moduleTabs.length > 0 && <div role="group" aria-label={moduleTabs.length === 1 ? contribution?.title : undefined} aria-labelledby={moduleTabs.length > 1 ? `${id}-module-title` : undefined} style={{ flexShrink: 0 }}>
                    {moduleTabs.length > 1 && <div id={`${id}-module-title`} className="sd-ui-muted" style={{ fontSize: 11, padding: '0 12px' }}>{contribution?.title}</div>}
                    <div style={{ display: 'flex' }}>{tabs.filter(tab => tab.moduleTab).map(tabButton)}</div>
                </div>}
            </div>
            <div role="tabpanel" id={`${id}-panel-${selected.key}`} aria-labelledby={`${id}-tab-${selected.key}`} tabIndex={0}
                style={{ flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', overflowWrap: 'anywhere', padding: '16px 20px' }}>
                {selected.key === 'chat' ? <ChatSettingsPanel /> : selected.key === 'themes' ? <ThemeSettingsPanel />
                    : selected.moduleTab && moduleId && <ModuleSettingsPanel key={JSON.stringify([worldId, moduleId, selected.key, retry])}
                        moduleId={moduleId} tab={selected.moduleTab} onSession={registerSession} onRetry={() => requestNavigation({ retry: true })} />}
            </div>
            <footer className="border-t sd-ui-divider" style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 20px' }}>
                <button type="button" onClick={() => requestNavigation({ close: true })} className="sd-ui-button" style={{ minHeight: 40, padding: '8px 16px', cursor: 'pointer', fontSize: 14 }}>Done</button>
            </footer>
        </div>
        <ConfirmationModal topLayer isOpen={pending !== null} title="Discard unsaved changes?"
            message="This panel has unsaved changes. Discard them and continue?" confirmLabel="Discard" cancelLabel="Continue editing" isDanger
            onCancel={() => setPending(null)} onConfirm={() => { if (pending) navigate(pending); }} />
    </dialog>, document.body);
}
