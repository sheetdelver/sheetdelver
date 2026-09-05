import React, { useState } from 'react';
import { SharedContentModal } from '@client/ui/components/SharedContentModal';
import { ConfirmationModal } from '@client/ui/components/ConfirmationModal';
import SystemTools from '@client/ui/components/SystemTools';
import { useNotifications } from '@client/ui/components/NotificationSystem';
import * as foundryApi from '@client/ui/api/foundryApi';
import { Theme } from '../hooks/useTheme';
import { ActorCard } from '../components/ActorCard';
import type { ActorDto, ActorListPayload } from '@shared/contracts/actors';
import type { AppSystemInfo, User } from '@shared/interfaces';

interface DashboardViewProps {
    system: AppSystemInfo | null;
    user: User | null;
    ownedActors: ActorDto[];
    token: string | null;
    theme: Theme;
    configUrl: string;
    appVersion: string;
    fetchActors: () => Promise<ActorListPayload | void>;
    setLoading: (loading: boolean) => void;
    setLoginMessage: (msg: string) => void;
}

export const DashboardView = ({
    system,
    user,
    ownedActors,
    token,
    theme,
    configUrl,
    appVersion,
    fetchActors,
    setLoading,
    setLoginMessage
}: DashboardViewProps) => {
    const { addNotification } = useNotifications();
    const canDeleteActors = user?.canDeleteActors === true;
    const [confirmDelete, setConfirmDelete] = useState<{ isOpen: boolean, actorId: string, actorName: string }>({
        isOpen: false,
        actorId: '',
        actorName: ''
    });

    const handleDeleteActor = async () => {
        if (!confirmDelete.actorId) return;

        // This is a courtesy guard for stale UI state. The authenticated
        // Foundry transport remains the authority for every delete request.
        if (!canDeleteActors) {
            addNotification('Foundry does not permit your role to delete characters.', 'error');
            setConfirmDelete({ isOpen: false, actorId: '', actorName: '' });
            return;
        }

        setLoading(true);
        setLoginMessage(`Deleting ${confirmDelete.actorName}...`);

        try {
            await foundryApi.deleteActor(token, confirmDelete.actorId);
            addNotification(`Deleted ${confirmDelete.actorName}`, 'success');
            await fetchActors();
        } catch (e) {
            const message = e instanceof Error ? e.message : 'Unknown error';
            addNotification(`Error: ${message}`, 'error');
        } finally {
            setLoading(false);
            setLoginMessage('');
            setConfirmDelete({ isOpen: false, actorId: '', actorName: '' });
        }
    };

    const confirmDeletion = (id: string, name: string) => {
        if (!canDeleteActors) return;
        setConfirmDelete({
            isOpen: true,
            actorId: id,
            actorName: name
        });
    };

    return (
        <div className="flex-1 w-full">
            {/* Reconnecting Overlay */}
            {system?.status !== 'active' && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm transition-all duration-500">
                    <div className={`${theme.panelBg} ${theme.text} border-2 border-amber-500/50 p-8 rounded-xl shadow-2xl max-w-sm w-full mx-4 text-center transform scale-100 animate-in fade-in zoom-in duration-300`}>
                        <div className="mb-4 flex justify-center">
                            <div className="w-12 h-12 border-4 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
                        </div>
                        <h2 className="text-xl font-bold mb-2">Connection Lost</h2>
                        <p className="text-slate-400 mb-6">Foundry is currently unreachable. Reconnecting...</p>
                        <div className="text-xs font-mono py-1 px-3 bg-black/30 rounded inline-block text-slate-500 uppercase tracking-widest">
                            CORE_STATUS: {system?.status || 'UNKNOWN'}
                        </div>
                    </div>
                </div>
            )}

            <div className="max-w-7xl mx-auto space-y-8 p-6 bg-black/60 rounded-xl backdrop-blur-sm border border-white/10">
                {/* Overlays */}
                <SharedContentModal />

                {/* Header / Status */}
                <div className="flex justify-between items-center bg-black/40 p-4 rounded-lg border border-white/5">
                    <div>
                        <h2 className={`text-2xl ${theme.headerFont} ${theme.accent}`}>
                            {system?.worldTitle || 'Dashboard'}
                        </h2>
                        <div className="flex flex-col md:flex-row md:items-center md:gap-2 text-xs opacity-50">
                            {system?.worldTitle && (
                                <>
                                    <span className="font-bold tracking-widest uppercase">Dashboard</span>
                                </>
                            )}
                            <div className="flex items-center gap-2">
                                <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
                                <span className="font-bold text-white">
                                    Connected as {user?.name || 'Connecting...'}
                                </span>
                                <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
                                <span>{configUrl}</span>
                            </div>
                        </div>
                    </div>
                </div>


                {/* System Specific Tools (Modularized) */}
                {system?.id && (
                    <SystemTools
                        systemId={system.id}
                        setLoading={setLoading}
                        setLoginMessage={setLoginMessage}
                        theme={theme}
                        token={token}
                    />
                )}

                {/* Owned Actors */}
                <div>
                    <div className="flex items-center gap-3 mb-4">
                        <h3 className={`text-xl font-bold uppercase tracking-widest opacity-80 ${theme.accent}`}>Characters</h3>
                        <div className="h-px flex-1 bg-white/10"></div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {ownedActors.length === 0 && <p className="opacity-50 italic text-sm py-4">You don&apos;t own any characters in this world.</p>}
                        {ownedActors.map((actor, idx) => (
                            <ActorCard
                                key={actor.id}
                                actor={actor}
                                index={idx}
                                theme={theme}
                                canDelete={canDeleteActors}
                                onDelete={confirmDeletion}
                            />
                        ))}
                    </div>
                </div>
            </div>

            {/* Footer Info Box */}
            <div className="w-full max-w-7xl mx-auto mt-12 bg-black/80 backdrop-blur-md p-6 rounded-xl border border-white/10 text-center md:text-right shadow-2xl">
                <div className="text-4xl font-black tracking-tighter text-white mb-2 underline decoration-amber-500 underline-offset-8 decoration-4" style={{ fontFamily: 'var(--font-cinzel), serif' }}>
                    SheetDelver
                </div>
                {system && (
                    <div className={`text-sm font-bold tracking-widest opacity-80 mb-2 ${theme.accent}`}>
                        {system.title?.toUpperCase()} ({system.version?.toString().toUpperCase()})
                    </div>
                )}
                <div className="text-[10px] opacity-30 font-mono tracking-wide mb-4">
                    v{appVersion || '...'}
                </div>

                <div className="flex justify-center md:justify-end gap-4">
                    <a
                        href="https://github.com/juvinious/sheet-delver"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 opacity-50 hover:opacity-100 transition-opacity text-sm font-mono"
                    >
                        <img src="https://img.shields.io/badge/github-repo-blue?logo=github" alt="GitHub Repo" className="opacity-80" />
                    </a>
                </div>
            </div>

            <ConfirmationModal
                isOpen={confirmDelete.isOpen}
                title="Delete Character"
                message={`Are you sure you want to delete ${confirmDelete.actorName}? This action cannot be undone.`}
                confirmLabel="Delete"
                cancelLabel="Keep"
                isDanger={true}
                onConfirm={handleDeleteActor}
                onCancel={() => setConfirmDelete({ ...confirmDelete, isOpen: false })}
                theme={system?.componentStyles?.modal}
            />
        </div>
    );
};
