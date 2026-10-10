import React, { useState } from 'react';
import Link from 'next/link';
import { Swords } from 'lucide-react';
import { SharedContentModal } from '@client/ui/components/SharedContentModal';
import { ConfirmationModal } from '@client/ui/components/ConfirmationModal';
import SystemTools from '@client/ui/components/SystemTools';
import { useNotifications } from '@client/ui/components/NotificationSystem';
import * as foundryApi from '@client/ui/api/foundryApi';
import { ActorCard } from '../components/ActorCard';
import type { ActorDto, ActorListPayload } from '@shared/contracts/actors';
import type { AppSystemInfo, User } from '@shared/interfaces';

interface DashboardViewProps {
    system: AppSystemInfo | null;
    user: User | null;
    ownedActors: ActorDto[];
    token: string | null;
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
            <div className="max-w-7xl mx-auto space-y-8 p-4 sm:p-6 sd-ui-panel rounded-xl backdrop-blur-sm">
                {/* Overlays */}
                <SharedContentModal />

                {/* Header / Status */}
                <div className="flex justify-between items-center sd-ui-inset p-4 rounded-lg">
                    <div>
                        <h2 className="text-2xl font-bold sd-ui-accent">
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
                                <span className="font-bold">
                                    Connected as {user?.name || 'Connecting...'}
                                </span>
                                <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
                                <span>{configUrl}</span>
                            </div>
                        </div>
                    </div>
                </div>


                {/* System Specific Tools (Modularized) */}
                {(user?.role ?? 0) >= 4 && (
                    <section aria-label="GM Tools">
                        <div className="flex items-center gap-3 mb-4">
                            <h3 className="text-xl font-bold uppercase tracking-widest sd-ui-accent">GM Tools</h3>
                            <div className="h-px flex-1 sd-ui-divider border-t" />
                        </div>
                        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                            <Link href="/tools/combat" className="sd-ui-panel-raised group flex items-center gap-4 rounded-xl p-4 shadow-lg backdrop-blur-md transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl">
                                <span className="sd-ui-inset sd-ui-accent flex h-16 w-16 shrink-0 items-center justify-center rounded-lg">
                                    <Swords aria-hidden="true" className="h-8 w-8" />
                                </span>
                                <span className="min-w-0">
                                    <span className="sd-ui-accent block truncate text-lg font-bold">Combat Manager</span>
                                    <span className="sd-ui-muted mt-1 block text-sm">Build and run tokenless encounters</span>
                                </span>
                            </Link>
                        </div>
                    </section>
                )}
                {system?.id && (
                    <SystemTools
                        key={system.id}
                        systemId={system.id}
                    />
                )}

                {/* Owned Actors */}
                <div>
                    <div className="flex items-center gap-3 mb-4">
                        <h3 className="text-xl font-bold uppercase tracking-widest sd-ui-accent">Characters</h3>
                        <div className="h-px flex-1 sd-ui-divider border-t"></div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {ownedActors.length === 0 && <p className="opacity-50 italic text-sm py-4">You don&apos;t own any characters in this world.</p>}
                        {ownedActors.map((actor, idx) => (
                            <ActorCard
                                key={actor.id}
                                actor={actor}
                                index={idx}
                                canDelete={canDeleteActors}
                                onDelete={confirmDeletion}
                            />
                        ))}
                    </div>
                </div>
            </div>

            {/* Footer Info Box */}
            <div className="w-full max-w-7xl mx-auto mt-12 sd-ui-panel backdrop-blur-md p-6 rounded-xl text-center md:text-right shadow-2xl">
                <div className="text-4xl font-black tracking-tighter mb-2 underline underline-offset-8 decoration-4 sd-ui-accent" style={{ fontFamily: 'var(--font-cinzel), serif' }}>
                    SheetDelver
                </div>
                {system && (
                    <div className="text-sm font-bold tracking-widest sd-ui-accent mb-2">
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
