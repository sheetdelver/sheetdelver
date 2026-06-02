'use client';

import React, { use, useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { getUIModule, invalidateModuleSourceCache } from '@modules/registry/client';
import LoadingModal from '@client/ui/components/LoadingModal';
import GenericActorPage from '@client/ui/pages/GenericActorPage';
import { SurfaceHost } from '@client/ui/components/SurfaceHost';
import { createActorPage } from '@shared/sdk';

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
    const [ActorPage, setActorPage] = useState<React.ComponentType<{ actorId: string; token?: string | null }> | null>(null);
    const [moduleId, setModuleId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // Incrementing this key causes the resolve effect to re-run in place,
    // giving us an in-page reload of the module UI without a full navigation.
    const [resolveKey, setResolveKey] = useState(0);
    // resolvedSystemIdRef tracks the adapter's systemId (may be 'generic' when module is disabled).
    // foundrySystemIdRef tracks the real Foundry game system (always e.g. 'dnd5e').
    // Socket events carry the moduleId (game system), so we match against foundrySystemIdRef
    // to correctly re-resolve even when the module is currently disabled and showing generic.
    const resolvedSystemIdRef = useRef<string | null>(null);
    const foundrySystemIdRef  = useRef<string | null>(null);

    // Re-resolve the module UI whenever the server signals any change affecting
    // this actor's system: source switch, enable/disable, install/upgrade/uninstall.
    useEffect(() => {
        if (!appSocket) return;
        const handle = ({ moduleId }: { moduleId: string }) => {
            const mod = moduleId.toLowerCase();
            // Match against both the adapter systemId AND the underlying Foundry system.
            // The latter is critical on re-enable: the page may be showing 'generic'
            // while foundrySystemId is still 'dnd5e', so we need the Foundry ref to match.
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

        async function resolveActorPage() {
            try {
                const headers: HeadersInit = {};
                if (token) headers['Authorization'] = `Bearer ${token}`;

                const res = await fetch(`/api/actors/${id}`, { headers });
                if (!res.ok) {
                    if (res.status === 401 || res.status === 503) {
                        router.push('/');
                        return;
                    }
                    setError(`Actor not found (${res.status})`);
                    return;
                }

                const data = await res.json();
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
                setError('Failed to load actor: ' + e.message);
            } finally {
                setLoading(false);
            }
        }

        setActorPage(null);
        setLoading(true);
        setError(null);
        resolveActorPage();
    }, [id, token, router, resolveKey]);

    if (loading) return <LoadingModal message="Loading..." />;

    if (error) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-neutral-900 text-white">
                <div className="text-center p-8 bg-black/40 rounded border border-white/10">
                    <h1 className="text-xl font-bold text-red-500 mb-2">Error</h1>
                    <p className="opacity-70 mb-4">{error}</p>
                    <button
                        onClick={() => router.push('/')}
                        className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 rounded transition-colors"
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
