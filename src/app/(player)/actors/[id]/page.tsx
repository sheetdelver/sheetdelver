'use client';

import React, { use, useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { useSession } from '@client/ui/context/SessionContext';
import { useRealtime } from '@client/ui/context/RealtimeContext';
import { getUIModule, invalidateModuleSourceCache } from '@modules/registry/client';
import LoadingModal from '@client/ui/components/LoadingModal';
import GenericActorPage from '@client/ui/pages/GenericActorPage';
import { SurfaceHost } from '@client/ui/components/SurfaceHost';
import { createActorPage } from '@shared/sdk/client-hooks';

/**
 * Core actor page router.
 * Fetches the actor to determine its systemId, then delegates rendering
 * to the module-specific actorPage component registered in the module manifest.
 * Falls back to GenericActorPage when the module does not provide an actorPage.
 * All resolved components are wrapped in SDKProvider so module code can
 * call useSDK() and useSDKComponents() freely.
 */
export default function ActorPageRouter({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const router = useRouter();
    const { token, appSocket } = useFoundry();
    const { linkState } = useRealtime();
    const { invalidateLocalSession } = useSession();
    const [ActorPage, setActorPage] = useState<React.ComponentType<{ actorId: string; token?: string | null }> | null>(null);
    const [moduleId, setModuleId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // Incrementing this key causes the resolve effect to re-run in place,
    // giving us an in-page reload of the module UI without a full navigation.
    const [resolveKey, setResolveKey] = useState(0);
    // resolvedSystemIdRef tracks the adapter's systemId (may be 'generic' when module is disabled).
    // foundrySystemIdRef tracks the real Foundry game system even when the adapter falls back.
    // Socket events carry the moduleId (game system), so we match against foundrySystemIdRef
    // to correctly re-resolve even when the module is currently disabled and showing generic.
    const resolvedSystemIdRef = useRef<string | null>(null);
    const foundrySystemIdRef  = useRef<string | null>(null);
    const previousLinkStateRef = useRef(linkState);

    useEffect(() => {
        const recovered = previousLinkStateRef.current !== 'ready' && linkState === 'ready';
        previousLinkStateRef.current = linkState;
        if (recovered && error && !error.includes('404')) setResolveKey(key => key + 1);
    }, [linkState, error]);

    // Re-resolve the module UI whenever the server signals any change affecting
    // this actor's system: source switch, enable/disable, install/upgrade/uninstall.
    useEffect(() => {
        if (!appSocket) return;
        const handle = ({ moduleId }: { moduleId: string }) => {
            const mod = moduleId.toLowerCase();
            // Match against both the adapter systemId AND the underlying Foundry system.
            // The latter is critical on re-enable: the page may be showing 'generic'
            // while foundrySystemId still points at the game system, so the Foundry ref must match.
            const matches =
                resolvedSystemIdRef.current?.toLowerCase() === mod ||
                foundrySystemIdRef.current?.toLowerCase()  === mod;
            if (matches) {
                invalidateModuleSourceCache();
                setResolveKey(k => k + 1);
            }
        };
        appSocket.on('moduleSourceChanged',   handle);
        appSocket.on('moduleStateChanged',    handle);
        appSocket.on('moduleRegistryChanged', handle);
        return () => {
            appSocket.off('moduleSourceChanged',   handle);
            appSocket.off('moduleStateChanged',    handle);
            appSocket.off('moduleRegistryChanged', handle);
        };
    }, [appSocket]);

    useEffect(() => {
        if (!id) return;
        let current = true;

        async function resolveActorPage() {
            try {
                const res = await fetch(`/api/actors/${id}`, { credentials: 'same-origin' });
                if (!current) return;
                if (!res.ok) {
                    if (res.status === 401) {
                        invalidateLocalSession('actor-route-401');
                        return;
                    }
                    setError(res.status === 404
                        ? 'Actor not found (404)'
                        : `Actor temporarily unavailable (${res.status})`);
                    return;
                }

                const data = await res.json();
                if (!current) return;
                const systemId = data.systemId;

                if (!systemId) {
                    setError('Could not determine system for this actor.');
                    return;
                }

                resolvedSystemIdRef.current = systemId;
                setModuleId(systemId);
                // Always capture the real Foundry system even when module is disabled
                // and systemId has fallen back to 'generic'.
                if (data.foundrySystemId) foundrySystemIdRef.current = data.foundrySystemId;
                const manifest = await getUIModule(systemId);
                if (!current) return;
                const actorPageEntry = manifest?.actorPage;

                if (actorPageEntry) {
                    // Module ships a bespoke actor page (the escape hatch, decision 16).
                    const ResolvedComponent = typeof actorPageEntry === 'function'
                        ? React.lazy(actorPageEntry as any)
                        : actorPageEntry;
                    setActorPage(() => ResolvedComponent as any);
                } else if (manifest?.sheet) {
                    // No custom actorPage: host the module's presentational Sheet in the
                    // default platform actor page via createActorPage (decision 16).
                    const sheetEntry = manifest.sheet;
                    const ResolvedSheet = typeof sheetEntry === 'function'
                        ? React.lazy(sheetEntry as any)
                        : sheetEntry;
                    const HostedPage = createActorPage(ResolvedSheet as any);
                    setActorPage(() => HostedPage as any);
                } else {
                    // Neither actorPage nor sheet (e.g. generic fallback) — platform generic page.
                    setActorPage(() => GenericActorPage as any);
                }
            } catch (e: any) {
                if (current) setError('Failed to load actor: ' + e.message);
            } finally {
                if (current) setLoading(false);
            }
        }

        setActorPage(null);
        setLoading(true);
        setError(null);
        void resolveActorPage();
        return () => { current = false; };
    }, [id, resolveKey, invalidateLocalSession]);

    if (loading) return <LoadingModal message="Loading..." />;

    if (error) {
        return (
            <div className="sd-ui-page flex items-center justify-center p-4">
                <div className="sd-ui-panel-raised text-center p-8 rounded max-w-md">
                    <h1 className="sd-ui-danger text-xl font-bold mb-2">Error</h1>
                    <p className="sd-ui-muted mb-4">{error}</p>
                    {!error.includes('404') && (
                        <button onClick={() => setResolveKey(key => key + 1)} className="sd-ui-button sd-ui-button-primary mr-2 px-4 py-2">
                            Retry
                        </button>
                    )}
                    <button
                        onClick={() => router.push('/')}
                        className="sd-ui-button px-4 py-2"
                    >
                        Back to Dashboard
                    </button>
                </div>
            </div>
        );
    }

    if (!ActorPage) return null;

    return (
        <SurfaceHost moduleId={moduleId ?? undefined} surface="actorPage">
            <ActorPage actorId={id} token={token} />
        </SurfaceHost>
    );
}
