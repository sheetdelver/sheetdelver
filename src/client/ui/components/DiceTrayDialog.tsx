'use client';

import { useEffect, useRef } from 'react';
import DiceTray from './DiceTray';
import { RollMode } from '@shared/sdk';
import { useFoundry } from '@client/ui/context/FoundryContext';

interface DiceTrayDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSend?: (msg: string, options?: { rollMode?: RollMode; speaker?: string }) => void;
    speaker?: string;
}

export default function DiceTrayDialog({ isOpen, onClose, onSend, speaker }: DiceTrayDialogProps) {
    const { system: adapter } = useFoundry();
    const popupRef = useRef<HTMLDivElement>(null);

    // Kept for compatibility with modules that may still import internal UI components.
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (popupRef.current && !popupRef.current.contains(event.target as Node)) {
                onClose();
            }
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const s = adapter?.componentStyles?.globalChat || {
        window: "fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200",
        header: "bg-black p-4 flex justify-between items-center",
        title: "font-serif font-bold text-xl uppercase tracking-widest text-white mx-auto",
        closeBtn: "text-white hover:text-amber-500 transition-colors"
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div
                ref={popupRef}
                className={`w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-200 ${adapter?.componentStyles?.globalChat?.window || 'bg-neutral-900 border border-white/10 rounded-2xl shadow-2xl'}`}
            >
                <div className={s.header}>
                    <h3 className={s.title}>Dice Tray</h3>
                    <button
                        onClick={onClose}
                        className={s.closeBtn}
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                        </svg>
                    </button>
                </div>
                <div className="p-0">
                    <DiceTray onSend={(msg, options) => { if (onSend) onSend(msg, { ...options, speaker: options?.speaker || speaker }); onClose(); }} hideHeader={true} speaker={speaker} />
                </div>
            </div>
        </div>
    );
}
