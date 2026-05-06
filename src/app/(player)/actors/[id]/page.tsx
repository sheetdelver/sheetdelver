'use client';

import React, { use, useEffect, useState, useRef, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { getUIModule, invalidateModuleSourceCache } from '@modules/registry/client';
import LoadingModal from '@client/ui/components/LoadingModal';
import GenericActorPage from '@client/ui/pages/GenericActorPage';
import { SDKProvider } from '@client/ui/providers/SDKProvider';

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
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // Incrementing this key causes the resolve effect to re-run in place,
    // giving us an in-page reload of the module UI without a full navigation.
    const [resolveKey, setResolveKey] = useState(0);
    // Stored in a ref (not state) so the socket handler always sees the latest
    // systemId without needing to be in the effect's dependency array.
    const resolvedSystemIdRef = useRef<string | null>(null);

    // When an admin switches a module's active source (local ↔ managed) the server
    // broadcasts 'moduleSourceChanged'. If the system currently rendered by this
    // actor page is the one that changed, we:
    //   1. Bust the source-map + manifest cache (invalidateModuleSourceCache).
    //   2. Increment resolveKey, which re-runs the resolve effect below and
    //      swaps in the component from the new source — no page refresh needed.
    useEffect(() => {
        if (!appSocket) return;
        const handle = ({ moduleId }: { moduleId: string }) => {
            if (resolvedSystemIdRef.current?.toLowerCase() === moduleId.toLowerCase()) {
                invalidateModuleSourceCache();
                setResolveKey(k => k + 1);
            }
        };
        appSocket.on('moduleSourceChanged', handle);
        return () => { appSocket.off('moduleSourceChanged', handle); };
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
                const manifest = await getUIModule(systemId);
                const actorPageEntry = manifest?.actorPage;

                if (actorPageEntry) {
                    const ResolvedComponent = typeof actorPageEntry === 'function'
                        ? React.lazy(actorPageEntry as any)
                        : actorPageEntry;
                    setActorPage(() => ResolvedComponent as any);
                } else {
                    // Module does not provide a custom actorPage — use platform fallback.
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
        <SDKProvider>
            <Suspense fallback={<LoadingModal message="Loading..." />}>
                <ActorPage actorId={id} token={token} />
            </Suspense>
        </SDKProvider>
    );
}
