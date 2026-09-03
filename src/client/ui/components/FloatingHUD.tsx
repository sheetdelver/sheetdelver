'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Home, MessageSquare, Users, Book, ChevronUp, ChevronDown, ChevronLeft, X } from 'lucide-react';
import { useUI } from '@client/ui/context/UIContext';
import { useChat } from '@client/ui/context/ChatContext';
import { useSession } from '@client/ui/context/SessionContext';
import { useRouter, usePathname } from 'next/navigation';

export default function FloatingHUD() {
    const {
        isChatOpen, setChatOpen,
        isDiceTrayOpen, setDiceTrayOpen,
        isJournalOpen, setJournalOpen,
        isPlayerListOpen, setPlayerListOpen
    } = useUI();
    const { messages } = useChat();
    const { users, step } = useSession();
    const [isMinimized, setIsMinimized] = useState(true);
    const pathname = usePathname();
    const router = useRouter();
    const hudRef = useRef<HTMLDivElement>(null);

    const activeCount = users?.filter(u => u.active).length || 0;

    const anyToolOpen = isChatOpen || isDiceTrayOpen || isJournalOpen || isPlayerListOpen;

    const toggleTool = (tool: 'chat' | 'dice' | 'journal' | 'players') => {
        // Enforce mutual exclusivity
        if (tool === 'chat') {
            const next = !isChatOpen;
            setChatOpen(next);
            if (next) { setDiceTrayOpen(false); setJournalOpen(false); setPlayerListOpen(false); }
        }
        if (tool === 'dice') {
            const next = !isDiceTrayOpen;
            setDiceTrayOpen(next);
            if (next) { setChatOpen(false); setJournalOpen(false); setPlayerListOpen(false); }
        }
        if (tool === 'journal') {
            const next = !isJournalOpen;
            setJournalOpen(next);
            if (next) { setChatOpen(false); setDiceTrayOpen(false); setPlayerListOpen(false); }
        }
        if (tool === 'players') {
            const next = !isPlayerListOpen;
            setPlayerListOpen(next);
            if (next) { setChatOpen(false); setDiceTrayOpen(false); setJournalOpen(false); }
        }
    };

    const closeAll = useCallback(() => {
        setChatOpen(false);
        setDiceTrayOpen(false);
        setJournalOpen(false);
        setPlayerListOpen(false);
        setIsMinimized(false); // Return to menu
    }, [setChatOpen, setDiceTrayOpen, setJournalOpen, setPlayerListOpen]);

    // Click outside handler
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Node;
            if (hudRef.current && !hudRef.current.contains(target)) {
                // Ignore clicks inside tool panels
                if ((event.target as Element).closest('.hud-panel')) return;

                // Check if any tools are open - if so, just close tools and reopen HUD menu
                if (anyToolOpen) {
                    setChatOpen(false);
                    setDiceTrayOpen(false);
                    setJournalOpen(false);
                    setPlayerListOpen(false);
                    setIsMinimized(false); // Open menu back up
                } else if (!isMinimized) {
                    setIsMinimized(true);
                }
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [anyToolOpen, isMinimized, setChatOpen, setDiceTrayOpen, setJournalOpen, setPlayerListOpen]);

    // Re-open menu when tool is closed manually
    useEffect(() => {
        if (!anyToolOpen && !isMinimized) {
            // Keep menu open
        }
    }, [anyToolOpen, isMinimized]);

    // Hide HUD if not fully connected/authenticated
    if (['init', 'setup', 'authenticating', 'login', 'logging-out', 'startup', 'initializing'].includes(step)) return null;

    return (
        <div
            ref={hudRef}
            className={`fixed bottom-6 z-[150] transition-all duration-500 ease-in-out pointer-events-auto
                ${isMinimized
                    ? 'left-1/2 -translate-x-1/2 sm:left-auto sm:right-6 sm:translate-x-0'
                    : 'left-1/2 -translate-x-1/2 sm:left-auto sm:right-6 sm:translate-x-0'
                }`}
        >
            <div className={`flex items-center gap-1 sm:gap-2 p-2 rounded-2xl shadow-2xl backdrop-blur-2xl border transition-all duration-500
                ${isMinimized
                    ? 'bg-black/80 border-white/10 rounded-full'
                    : 'bg-black/90 border-white/20 sm:flex-row-reverse'
                }`}
            >
                {/* Trigger / Collapse Button */}
                <button
                    onClick={() => {
                        if (anyToolOpen) {
                            closeAll();
                        } else {
                            setIsMinimized(!isMinimized);
                        }
                    }}
                    className={`p-3 rounded-full transition-all duration-500 flex items-center justify-center
                        ${isMinimized ? 'text-amber-500 hover:scale-110' : 'text-white/40 hover:text-white rotate-[360deg]'}
                    `}
                >
                    {isMinimized ? (
                        <>
                            <ChevronLeft className="w-6 h-6 hidden sm:block" />
                            <ChevronUp className="w-6 h-6 sm:hidden" />
                        </>
                    ) : (
                        <X className="w-6 h-6" />
                    )}
                </button>

                {!isMinimized && (
                    <div className="flex items-center gap-1 sm:gap-2 animate-in fade-in zoom-in-95 duration-300">
                        {/* If a tool is open, we show ONLY that tool's icon in a consolidated view? 
                            The user said "consolidate the ui bar just to the current open item".
                            This implies if I open Journals, the other buttons disappear. */}

                        {(isJournalOpen || !anyToolOpen) && (
                            <button
                                onClick={() => toggleTool('journal')}
                                className={`p-3 rounded-xl transition-all relative ${isJournalOpen ? 'bg-blue-600 text-white' : 'text-white/60 hover:bg-white/5 hover:text-white'}`}
                                title="Journals"
                            >
                                <Book className="w-6 h-6" />
                            </button>
                        )}

                        {(isChatOpen || !anyToolOpen) && (
                            <button
                                onClick={() => toggleTool('chat')}
                                className={`p-3 rounded-xl transition-all relative ${isChatOpen ? 'bg-amber-500 text-black' : 'text-white/60 hover:bg-white/5 hover:text-white'}`}
                                title="Game Chat"
                            >
                                <MessageSquare className="w-6 h-6" />
                                {messages && messages.length > 0 && (
                                    <span className="absolute top-2 right-2 w-2 h-2 bg-red-500 rounded-full border border-black animate-pulse" />
                                )}
                            </button>
                        )}

                        {(isDiceTrayOpen || !anyToolOpen) && (
                            <button
                                onClick={() => toggleTool('dice')}
                                className={`p-3 rounded-xl transition-all flex items-center justify-center ${isDiceTrayOpen ? 'bg-rose-600 text-white' : 'text-white/60 hover:bg-white/5 hover:text-white'}`}
                                title="Dice Tray"
                            >
                                <img
                                    src="/icons/dice-d20.svg"
                                    alt="Dice"
                                    className={`w-6 h-6 ${isDiceTrayOpen ? 'brightness-0 invert' : 'brightness-0 invert opacity-60'}`}
                                />
                            </button>
                        )}

                        {(isPlayerListOpen || !anyToolOpen) && (
                            <button
                                onClick={() => toggleTool('players')}
                                className={`p-3 rounded-xl transition-all relative ${isPlayerListOpen ? 'bg-emerald-600 text-white' : 'text-white/60 hover:bg-white/5 hover:text-white'}`}
                                title="Player List"
                            >
                                <Users className="w-6 h-6" />
                                {activeCount > 0 && (
                                    <span className="absolute top-2 right-2 bg-emerald-400 text-black text-[9px] font-black h-4 w-4 flex items-center justify-center rounded-full ring-2 ring-black">
                                        {activeCount}
                                    </span>
                                )}
                            </button>
                        )}

                        {!anyToolOpen && (
                            <>
                                <div className="w-px h-8 bg-white/10 mx-1 hidden sm:block" />
                                <button
                                    onClick={() => { router.push('/'); setIsMinimized(true); }}
                                    className={`p-3 rounded-xl transition-all ${pathname === '/' ? 'bg-amber-500 text-black' : 'text-white/60 hover:bg-white/5 hover:text-white'}`}
                                    title="Dashboard"
                                >
                                    <Home className="w-6 h-6" />
                                </button>
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
