'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';

import SheetRouter from '@client/ui/components/SheetRouter';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { useUI } from '@client/ui/context/UIContext';
import { useConfig } from '@client/ui/context/ConfigContext';
import type { RealtimeActorUpdatePayload } from '@shared/contracts/realtime';
import { processHtmlContent } from '@modules/registry/client';
import { useNotifications } from '@client/ui/components/NotificationSystem';
import LoadingModal from '@client/ui/components/LoadingModal';
import { SharedContentModal } from '@client/ui/components/SharedContentModal';

export interface GenericActorPageProps {
    actorId: string;
    token?: string | null;
}

export default function GenericActorPage({ actorId }: GenericActorPageProps) {
    const router = useRouter();
    const {
        token,
        appSocket
    } = useFoundry();
    const { isDiceTrayOpen, toggleDiceTray } = useUI();
    const { addNotification: addToast } = useNotifications();
    const { foundryUrl, setFoundryUrl } = useConfig();

    const [actor, setActor] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [showDeleteModal, setShowDeleteModal] = useState(false);

    const fetchWithAuth = useCallback(async (input: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (token) headers.set('Authorization', `Bearer ${token}`);
        return fetch(input, { ...init, headers });
    }, [token]);

    const foundryUrlRef = useRef(foundryUrl);
    useEffect(() => { foundryUrlRef.current = foundryUrl; }, [foundryUrl]);

    const addNotification = useCallback((message: string, type: 'info' | 'success' | 'error' = 'info') => {
        const content = processHtmlContent(message, foundryUrlRef.current);
        addToast(content, type, { html: true });
    }, [addToast]);

    const actorFetchInFlightRef = useRef<{ actorId: string; request: Promise<void> } | null>(null);
    const actorRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const fetchActor = useCallback(async (id: string, silent = false) => {
        const inFlight = actorFetchInFlightRef.current;
        if (inFlight?.actorId === id) return inFlight.request;

        if (!silent) setLoading(true);
        const request = (async () => {
            try {
                const res = await fetchWithAuth(`/api/actors/${id}`);
                if (res.status === 503 || res.status === 401) {
                    router.push('/');
                    return;
                }
                if (res.status === 404) {
                    setShowDeleteModal(true);
                    return;
                }

                const data = await res.json();
                if (data && !data.error) {
                    setActor(data);
                    if (data.foundryUrl) setFoundryUrl(data.foundryUrl);
                } else {
                    if (res.status >= 500) {
                        addNotification('Server Error: ' + (data?.error || 'Unknown Error'), 'error');
                    } else {
                        setShowDeleteModal(true);
                    }
                }
            } catch (e: any) {
                addNotification('Connection Error: ' + e.message, 'error');
            } finally {
                if (!silent) setLoading(false);
            }
        })();

        actorFetchInFlightRef.current = { actorId: id, request };
        request.finally(() => {
            if (actorFetchInFlightRef.current?.request === request) {
                actorFetchInFlightRef.current = null;
            }
        });
        return request;
    }, [router, fetchWithAuth, addNotification, setFoundryUrl]);

    const requestActorRefresh = useCallback((id: string) => {
        if (actorRefreshTimerRef.current) {
            clearTimeout(actorRefreshTimerRef.current);
        }

        actorRefreshTimerRef.current = setTimeout(() => {
            actorRefreshTimerRef.current = null;
            void fetchActor(id, true);
        }, 75);
    }, [fetchActor]);

    const loadingRef = useRef(loading);
    useEffect(() => { loadingRef.current = loading; }, [loading]);

    useEffect(() => {
        if (!actorId) return;
        fetchActor(actorId);

        if (appSocket) {
            const handleActorUpdate = (data: RealtimeActorUpdatePayload) => {
                if (data.actorId === actorId) requestActorRefresh(actorId);
            };
            appSocket.on('actorUpdate', handleActorUpdate);
            return () => { appSocket.off('actorUpdate', handleActorUpdate); };
        }

        const timeout = setTimeout(() => {
            if (loadingRef.current) {
                addNotification('Loading is taking longer than expected. The server might be busy.', 'error');
            }
        }, 15000);

        return () => { clearTimeout(timeout); };
    }, [actorId, fetchActor, requestActorRefresh, addNotification, appSocket]);

    useEffect(() => () => {
        if (actorRefreshTimerRef.current) {
            clearTimeout(actorRefreshTimerRef.current);
            actorRefreshTimerRef.current = null;
        }
    }, []);

    const handleRoll = async (type: string, key: string, options: any = {}) => {
        if (!actor) return;
        const rollMode = localStorage.getItem('sheetdelver_roll_mode') || 'publicroll';
        const rollOptions = {
            ...options,
            rollMode: options.rollMode || rollMode,
            speaker: options.speaker || { actor: actor.id, alias: actor.name }
        };

        try {
            const res = await fetchWithAuth(`/api/actors/${actor.id}/roll`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, key, options: rollOptions })
            });
            const data = await res.json();
            if (data.success) {
                if (data.html) addNotification(data.html, 'success');
                else if (data.result?.total !== undefined) addNotification(`Rolled ${data.label || 'Result'}: ${data.result.total}`, 'success');
                else addNotification(`${data.label || 'Item'} used`, 'success');
            } else {
                addNotification('Roll failed: ' + data.error, 'error');
            }
        } catch (e: any) {
            addNotification('Error: ' + e.message, 'error');
        }
    };

    const handleUpdate = async (path: string, value: any) => {
        if (!actor) return;
        try {
            const res = await fetchWithAuth(`/api/actors/${actor.id}/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [path]: value })
            });
            const data = await res.json();
            if (data.success) fetchActor(actor.id, true);
            else addNotification('Update failed: ' + data.error, 'error');
        } catch (e: any) {
            addNotification('Error updating: ' + e.message, 'error');
        }
    };

    const handleDeleteItem = async (itemId: string) => {
        if (!actor) return;
        try {
            const res = await fetchWithAuth(`/api/actors/${actor.id}/items?itemId=${itemId}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                fetchActor(actor.id, true);
                addNotification('Item Deleted', 'success');
            } else {
                addNotification('Failed to delete item: ' + data.error, 'error');
            }
        } catch (e: any) {
            addNotification('Error: ' + e.message, 'error');
        }
    };

    const handleCreateItem = async (itemData: any) => {
        if (!actor) return;
        try {
            const res = await fetchWithAuth(`/api/actors/${actor.id}/items`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(itemData)
            });
            const data = await res.json();
            if (data.success) {
                fetchActor(actor.id, true);
                if (itemData.name) addNotification(`Created ${itemData.name}`, 'success');
            } else {
                addNotification('Failed to create item: ' + data.error, 'error');
            }
        } catch (e: any) {
            addNotification('Error: ' + e.message, 'error');
        }
    };

    if (loading) return <LoadingModal message="Loading..." />;
    if (!actor && !showDeleteModal) return null;

    return (
        <main className="min-h-screen font-sans pb-20">
            <nav className="fixed top-0 left-0 right-0 z-50 bg-neutral-900 border-b border-neutral-800 px-4 py-3 shadow-md flex items-center justify-between backdrop-blur-sm bg-opacity-95">
                <button
                    onClick={() => router.push('/')}
                    className="flex items-center gap-2 text-neutral-400 hover:text-white transition-colors font-semibold group text-sm uppercase tracking-wide cursor-pointer"
                >
                    <span className="group-hover:-translate-x-1 transition-transform">←</span>
                    Back to Dashboard
                </button>
                <div className="text-xs text-neutral-600 font-mono hidden md:block">
                    {actor?.name ?? 'Loading...'}
                </div>
            </nav>

            {actor && (
                <div className="w-full max-w-5xl mx-auto p-4 pt-20">
                    <SheetRouter
                        systemId={actor.systemId || 'generic'}
                        actor={actor}
                        foundryUrl={actor?.foundryUrl}
                        token={token}
                        isOwner={actor?.isOwner ?? true}
                        onRoll={handleRoll}
                        onUpdate={handleUpdate}
                        onDeleteItem={handleDeleteItem}
                        onCreateItem={handleCreateItem}
                        onToggleDiceTray={toggleDiceTray}
                        isDiceTrayOpen={isDiceTrayOpen}
                    />
                </div>
            )}

            <SharedContentModal />

            {showDeleteModal && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm p-4 animate-in fade-in duration-300">
                    <div className="bg-neutral-900 border border-red-900/40 p-8 rounded-xl max-w-md w-full text-center shadow-2xl">
                        <div className="text-5xl mb-4">💀</div>
                        <h2 className="text-2xl font-bold text-white mb-2">Character Deleted</h2>
                        <p className="text-neutral-400 mb-8">This character has been deleted from the world.</p>
                        <button
                            onClick={() => router.push('/')}
                            className="bg-red-900 hover:bg-neutral-700 text-white font-bold py-3 px-8 rounded shadow-lg uppercase tracking-widest transition-all w-full"
                        >
                            Return to Dashboard
                        </button>
                    </div>
                </div>
            )}
        </main>
    );
}
