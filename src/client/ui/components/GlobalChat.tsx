'use client';

import { useState, useRef, useEffect } from 'react';
import ChatTab from './ChatTab';
import DiceTray from './DiceTray';

import { MessageSquare } from 'lucide-react';
import { SystemAdapter, RollMode } from '@shared/sdk';



import { useChat } from '@client/ui/context/ChatContext';
import { useSession } from '@client/ui/context/SessionContext';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { useUI } from '@client/ui/context/UIContext';
import { useConfig } from '@client/ui/context/ConfigContext';

interface GlobalChatProps {
    hideDice?: boolean;
    speaker?: string;
}

export default function GlobalChat(props: GlobalChatProps) {
    const { hideDice, speaker } = props;
    const { messages, handleChatSend: onSend } = useChat();
    const { system } = useFoundry();
    const { step } = useSession();
    const { isChatOpen, setChatOpen, isDiceTrayOpen, setDiceTrayOpen } = useUI();
    const { foundryUrl } = useConfig();

    const onToggleDiceTray = () => setDiceTrayOpen(!isDiceTrayOpen);
    const setIsChatOpen = (open: boolean) => setChatOpen(open);

    const s = system?.config?.componentStyles?.globalChat || {
        window: "bg-neutral-900/95 backdrop-blur-xl border border-white/20 shadow-2xl rounded-xl",
        header: "flex justify-between items-center bg-white/10 p-3 border-b border-white/10",
        title: "text-[10px] font-bold uppercase text-white/60 pl-2 tracking-widest",
        diceWindow: "w-[400px]",
        chatWindow: "w-[400px] h-[80vh]",
        toggleBtn: (isOpen: boolean, isDice?: boolean) => `
            h-12 w-12 rounded-full shadow-lg flex items-center justify-center
            transition-all duration-300 hover:scale-110 active:scale-95 border border-white/10
            ${isDice
                ? (isOpen ? 'bg-white/10 text-white rotate-90' : 'bg-neutral-800 text-white hover:bg-neutral-700')
                : (isOpen ? 'bg-white/10 text-white rotate-90' : 'bg-amber-500 text-black hover:bg-amber-400')
            }
        `,
        closeBtn: "text-white/40 hover:text-white transition-colors"
    };

    // Use controlled state from context
    const isDiceOpen = isDiceTrayOpen;

    const toggleDice = onToggleDiceTray;

    const containerRef = useRef<HTMLDivElement>(null);

    // Click Outside Handler
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                // Ignore clicks on the toggle button itself to prevent double-toggling
                if ((event.target as Element).closest('.dice-tray-toggle')) return;

                // Only close if we are actually open
                if (isChatOpen) setChatOpen(false);

                // Close controlled or local
                if (isDiceOpen) setDiceTrayOpen(false);
            }
        };

        if (isChatOpen || isDiceOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isChatOpen, isDiceOpen, setChatOpen, setDiceTrayOpen]);

    return (
        <div
            ref={containerRef}
            data-step={step}
            className={`fixed bottom-24 left-1/2 -translate-x-1/2 sm:left-auto sm:right-6 sm:translate-x-0 z-[100] flex flex-col items-center sm:items-end gap-4 pointer-events-none $"font-inter" `}
        >

            {/* --- WINDOWS --- */}
            <div className="flex flex-col-reverse items-center gap-4 pointer-events-none hud-panel">

                {/* Dice Window (Conditional) */}
                {!props.hideDice && (
                    <div className={`
                        ${s.window}
                        w-[calc(100vw-2rem)] max-w-[400px]
                        transition-all duration-300 origin-bottom
                        ${isDiceOpen
                            ? 'opacity-100 scale-100 pointer-events-auto'
                            : 'opacity-0 scale-95 pointer-events-none h-0'
                        }
                    `}>
                        {isDiceOpen && (
                            <>
                                <div className={s.header || "flex justify-between items-center bg-white/5 p-3 border-b border-white/5"}>
                                    <span className={s.title || "text-[10px] font-bold uppercase text-white/40 pl-2 tracking-widest"}>Dice Tray</span>
                                    <button onClick={toggleDice} className={`${s.closeBtn} px-2`}>✕</button>
                                </div>
                                <div className="p-0">
                                    <DiceTray
                                        onSend={(msg, options) => { onSend(msg, { ...options, speaker: options?.speaker || props.speaker }); toggleDice(); }}
                                        hideHeader={true}
                                        speaker={props.speaker}
                                    />
                                </div>
                            </>
                        )}
                    </div>
                )}

                {/* Chat Window */}
                <div className={`
                    ${s.window}
                    ${s.chatWindow}
                    w-[calc(100vw-2rem)] max-w-[400px]
                    flex flex-col
                    transition-all duration-300 origin-bottom
                    ${isChatOpen
                        ? 'opacity-100 scale-100 pointer-events-auto'
                        : 'opacity-0 scale-95 pointer-events-none h-0'}
                `}>
                    <div className={`${s.header || "flex justify-between items-center bg-white/5 p-3 border-b border-white/5"} flex-none`}>
                        <span className={s.title || "text-[10px] font-bold uppercase text-white/40 pl-2 tracking-widest"}>
                            Game Chat {messages && messages.length > 0 && `(${messages.length})`}
                        </span>
                        <button onClick={() => setIsChatOpen(false)} className={`${s.closeBtn} px-2`}>✕</button>
                    </div>
                    <div className={`flex-1 min-h-0 ${!isChatOpen ? 'hidden' : ''}`}>
                        <ChatTab
                            messages={messages || []}
                            onSend={onSend}
                            foundryUrl={foundryUrl}
                            hideDiceTray={true}
                            hideHeader={true}
                            speaker={props.speaker}
                        />
                    </div>
                </div>

            </div>
        </div>
    );
}
