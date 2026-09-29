'use client';

import { useState, useEffect, useRef } from 'react';
import { Users } from 'lucide-react';
import type { User } from '@shared/interfaces';

import { useSession } from '@client/ui/context/SessionContext';
import { useUI } from '@client/ui/context/UIContext';

export default function PlayerList() {
    const { users, currentUser, handleLogout, step } = useSession();
    const currentUserId = currentUser?._id || currentUser?.id || null;
    const { isPlayerListOpen, setPlayerListOpen } = useUI();
    const isOpen = isPlayerListOpen;
    const setIsOpen = setPlayerListOpen;
    const containerRef = useRef<HTMLDivElement>(null);

    // Click Outside Handler
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen, setIsOpen]);

    if (!users || users.length === 0 || step === 'login' || step === 'logging-out') return null;

    const activeCount = users.filter(u => u.active).length;

    // Split Users
    const gamemasters = users.filter(u => u.isGM);
    const players = users.filter(u => !u.isGM);

    const activeGMCount = gamemasters.filter(u => u.active).length;
    const activePlayerCount = players.filter(u => u.active).length;

    const renderUserRow = (u: User) => {
        const isSelf = (u._id || u.id) === currentUserId;
        const shouldHighlight = isSelf;

        return (
            <li key={u._id || u.id || u.name} className={`flex items-center gap-2 px-2 py-1.5 rounded transition-all ${u.active ? 'opacity-100' : 'opacity-40'} ${shouldHighlight ? 'sd-ui-inset' : ''}`}>
                <div
                    className="w-2.5 h-2.5 rounded-full ring-2 ring-white/30"
                    style={{ backgroundColor: u.color || '#9ca3af', boxShadow: u.active && u.color ? `0 0 8px ${u.color}` : 'none' }}
                />
                <div className="flex flex-col leading-tight min-w-0">
                    <span className="text-sm font-bold flex items-center gap-1.5 truncate">
                        {u.name}
                        {u.isGM && <span className="text-[8px] sd-ui-button-primary px-1 rounded-sm font-black tracking-tighter">GM</span>}
                    </span>
                    {u.characterName && (
                        <span className="text-[10px] sd-ui-muted truncate">{u.characterName}</span>
                    )}
                </div>
            </li>
        );
    };

    return (
        <div ref={containerRef} className="fixed bottom-24 left-1/2 -translate-x-1/2 sm:left-auto sm:right-6 sm:translate-x-0 z-[110] flex flex-col items-center sm:items-end gap-4">

            {/* List Popup */}
            <div className={`
                sd-ui-panel-raised backdrop-blur-md rounded-xl shadow-2xl overflow-hidden
                transition-all duration-300 origin-bottom flex flex-col hud-panel
                ${isOpen ? 'w-[240px] opacity-100 scale-100 mb-0 translate-y-0' : 'w-[0px] h-[0px] opacity-0 scale-90 -mb-10 translate-y-10'}
            `}>
                {/* Header */}
                <div className="sd-ui-inset p-2 border-b sd-ui-divider flex justify-between items-center">
                    <span className="sd-ui-muted text-[10px] uppercase font-bold tracking-widest pl-1">
                        Participants ({activeCount}/{users.length})
                    </span>
                    <button onClick={() => setIsOpen(false)} className="sd-ui-muted hover:opacity-80 px-2">✕</button>
                </div>

                <div className="flex-1 overflow-y-auto max-h-[60vh] p-2 space-y-4">

                    {/* Players Section */}
                    {players.length > 0 && (
                        <div>
                            <div className="sd-ui-muted text-[10px] font-black mb-1 px-1 tracking-widest flex justify-between uppercase">
                                <span>Players</span>
                                <span>{activePlayerCount}/{players.length}</span>
                            </div>
                            <ul className="space-y-1">
                                {players.map(renderUserRow)}
                            </ul>
                        </div>
                    )}

                    {/* Gamemasters Section - Moved Below */}
                    {gamemasters.length > 0 && (
                        <div className={players.length > 0 ? "pt-2 border-t sd-ui-divider" : ""}>
                            <div className="sd-ui-accent text-[10px] font-black mb-1 px-1 tracking-widest flex justify-between uppercase mt-2">
                                <span>Gamemasters</span>
                                <span>{activeGMCount}/{gamemasters.length}</span>
                            </div>
                            <ul className="space-y-1">
                                {gamemasters.map(renderUserRow)}
                            </ul>
                        </div>
                    )}

                </div>

                <div className="p-2 border-t sd-ui-divider">
                    <button
                        onClick={handleLogout}
                        className="sd-ui-button sd-ui-danger w-full text-xs rounded py-1.5 transition-colors font-bold uppercase tracking-wider"
                    >
                        Logout
                    </button>
                </div>
            </div>
        </div>
    );
}
