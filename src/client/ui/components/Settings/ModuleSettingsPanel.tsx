import { useLayoutEffect, useState } from 'react';
import type { ModuleSettingsTab } from '@shared/sdk';
import { SurfaceHost } from '../SurfaceHost';
import { forgetSettingsPanel, getSettingsPanel } from './settingsPanelCache';

export interface SettingsPanelSession {
    controller: AbortController;
    readonly dirty: boolean;
    onDirtyChange: (dirty: boolean) => void;
}

/** A fresh committed mount owns the signal; late imports and callbacks cannot revive it. */
export function ModuleSettingsPanel({ moduleId, tab, onSession, onRetry }: {
    moduleId: string;
    tab: ModuleSettingsTab;
    onSession: (session: SettingsPanelSession) => void;
    onRetry: () => void;
}) {
    const [Panel] = useState(() => getSettingsPanel(tab.load));
    const [session, setSession] = useState<SettingsPanelSession | null>(null);
    useLayoutEffect(() => {
        const controller = new AbortController();
        let dirty = false;
        const next = { controller, get dirty() { return dirty; }, onDirtyChange: (value: boolean) => {
            if (!controller.signal.aborted) dirty = value === true;
        } };
        onSession(next);
        setSession(next);
        return () => { next.controller.abort(); };
    }, [onSession]);
    return <SurfaceHost moduleId={moduleId} surface="settingsTab"
        onError={() => session?.controller.abort()}
        loading={<p role="status">Loading settings…</p>}
        fallback={<div role="alert"><p>This settings panel could not be displayed.</p>
            <button type="button" className="sd-ui-button mt-3 px-3 py-2" onClick={() => {
                forgetSettingsPanel(tab.load);
                onRetry();
            }}>Retry</button></div>}>
        {session && <Panel signal={session.controller.signal} onDirtyChange={session.onDirtyChange} />}
    </SurfaceHost>;
}
