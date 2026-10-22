'use client';

import { useEffect, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { worldRuntimeHeaders } from '@client/ui/api/worldRuntime';
import { useModalFocus } from '@client/ui/hooks/useModalFocus';
import { SurfaceHost } from './SurfaceHost';
import RollDialogFrame from './RollDialogFrame';
import type { CompendiumReferenceIdentity, CompendiumReferenceViewer, CompendiumReferenceViewProps } from '@shared/sdk';

type Ready = { title: string; reference: CompendiumReferenceIdentity; model: unknown; View: ComponentType<CompendiumReferenceViewProps> };
type Open = { scope: string; provider: CompendiumReferenceViewer; ready?: Ready; message?: string };

/** Optional original-source card. Neither discovery nor loading gates combat. */
export function CompendiumReferenceLink({ combatId, combatantId, actorId, selectionKey, className }: {
    combatId: string; combatantId: string; actorId: string | null; selectionKey: string; className?: string;
}) {
    const { currentUser, worldId, system, step, appSocket, activeUIModule } = useFoundry();
    const provider = activeUIModule?.info.id === system?.id ? activeUIModule?.referenceViews?.Actor : undefined;
    const scope = JSON.stringify([worldId, currentUser?._id || currentUser?.id, currentUser?.role, system?.id, step, combatId, combatantId, actorId, selectionKey]);
    const [available, setAvailable] = useState<{ scope: string; provider: CompendiumReferenceViewer } | null>(null);
    const [open, setOpen] = useState<Open | null>(null);
    const generation = useRef(0);
    const opening = useRef<AbortController | null>(null);
    const panel = useRef<HTMLDivElement>(null);
    const close = () => { opening.current?.abort(); setOpen(null); };
    useModalFocus(panel, !!open, close);
    useEffect(() => {
        let disposed = false;
        let controller: AbortController | undefined;
        const retire = () => {
            generation.current++;
            controller?.abort(); opening.current?.abort(); setAvailable(null);
            setOpen(previous => previous ? { ...previous, ready: undefined, message: 'This reference is no longer current. Close it and open the reference again when available.' } : null);
        };
        const refresh = async () => {
            retire();
            if (!provider || step !== 'dashboard' || !worldId || appSocket?.connected === false) return;
            const ticket = generation.current;
            controller = new AbortController();
            try {
                const query = new URLSearchParams({ combatId, combatantId, availability: '1' });
                const response = await fetch(`/api/compendium-reference?${query}`, { credentials: 'same-origin', cache: 'no-store', headers: worldRuntimeHeaders(), signal: controller.signal });
                const data = await response.json();
                if (!disposed && ticket === generation.current && response.ok && data.status === 'resolved' && data.moduleId === system?.id && data.reference?.documentType === 'Actor') setAvailable({ scope, provider });
            } catch { /* Optional source is unavailable; no misleading link. */ }
        };
        const reload = () => { void refresh(); };
        const actorChanged = () => reload(); // Includes compendium Actor source invalidation.
        const combatChanged = (event: { combatId?: string }) => { if (!event.combatId || event.combatId === combatId) reload(); };
        const events = ['worldPackagesChanged', 'worldContextChanged', 'connect', 'actorListInvalidated', 'combatListInvalidated', 'userChanged', 'itemChanged', 'settingChanged', 'moduleSourceChanged', 'moduleStateChanged', 'moduleRegistryChanged'];
        events.forEach(event => appSocket?.on(event, reload));
        appSocket?.on('actorChanged', actorChanged); appSocket?.on('combatChanged', combatChanged); appSocket?.on('disconnect', retire);
        void refresh();
        return () => {
            disposed = true; controller?.abort(); opening.current?.abort();
            events.forEach(event => appSocket?.off(event, reload));
            appSocket?.off('actorChanged', actorChanged); appSocket?.off('combatChanged', combatChanged); appSocket?.off('disconnect', retire);
        };
    }, [scope, provider, step, worldId, system?.id, appSocket, actorId, combatId, combatantId]);
    const show = async () => {
        if (!provider || available?.scope !== scope || available.provider !== provider) return;
        opening.current?.abort();
        const controller = new AbortController(); opening.current = controller;
        const ticket = generation.current;
        setOpen({ scope, provider });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const query = new URLSearchParams({ combatId, combatantId });
            const [response, component] = await Promise.race([Promise.all([
                fetch(`/api/compendium-reference?${query}`, { credentials: 'same-origin', cache: 'no-store', headers: worldRuntimeHeaders(), signal: controller.signal }).then(async response => ({ ok: response.ok, data: await response.json() })),
                provider.load(),
            ]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Reference load timed out')), 10000); })]);
            const data = response.data;
            if (controller.signal.aborted || ticket !== generation.current) return;
            if (!response.ok || data.status !== 'resolved' || data.moduleId !== system?.id || data.reference?.documentType !== 'Actor') throw Error('unavailable');
            setOpen({ scope, provider, ready: { ...data, View: component.default } });
        } catch {
            if (!controller.signal.aborted && ticket === generation.current) setOpen({ scope, provider, message: 'This reference could not be loaded or is no longer available.' });
        } finally { clearTimeout(timer); controller.abort(); }
    };
    const ready = open?.scope === scope && open.provider === provider ? open.ready : undefined;
    const message = open?.scope !== scope || open.provider !== provider ? 'This reference is no longer current.' : open.message;
    return <>
        {available?.scope === scope && available.provider === provider && <button type="button" className={className ?? 'sd-ui-accent px-2 py-1 text-xs underline'} onClick={() => void show()}>View reference</button>}
        {open && createPortal(<SurfaceHost moduleId={system?.id ?? undefined} surface="compendiumReference">
            <RollDialogFrame title={ready?.title ?? 'Compendium reference'} theme={open.provider.dialog} onClose={close} dialogRef={panel} layer={160} footer={null}>
                {ready ? <SurfaceHost key={`${scope}:${ready.reference.uuid}`} moduleId={system?.id ?? undefined} surface="referenceContent"
                    loading={<p role="status">Loading reference…</p>} fallback={<p role="alert">This reference could not be displayed.</p>}>
                    <ready.View reference={ready.reference} model={ready.model} />
                </SurfaceHost> : <p role="status">{message ?? 'Loading reference…'}</p>}
            </RollDialogFrame>
        </SurfaceHost>, document.body)}
    </>;
}
